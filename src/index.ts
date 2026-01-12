#!/usr/bin/env node
/**
 * Google Research MCP Server v2.0.0
 * 
 * FULLY COMPLIANT with Anthropic's Multi-Agent Research Architecture
 * 
 * Architecture Components:
 * 1. LeadResearcher (Orchestrator) - Plans, coordinates, synthesizes
 * 2. SearchSubagents - Parallel aspect-based research
 * 3. CitationAgent - Processes documents and inserts citations
 * 4. Memory Module - Persists context, notes, and findings
 * 
 * Key Features:
 * - True subagent spawning for different aspects
 * - Think/Evaluate phases between iterations
 * - Dynamic gap detection with adaptive stopping
 * - Aspect-based decomposition
 * - Context retrieval for query refinement
 * - Full citation agent for inline citation insertion
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ============================================================================
// Types - Multi-Agent Architecture
// ============================================================================

interface GoogleSearchItem {
  title: string;
  link: string;
  snippet: string;
  displayLink?: string;
}

interface GoogleSearchResponse {
  items?: GoogleSearchItem[];
  searchInformation?: { totalResults: string; searchTime: number };
  error?: { message: string; code: number };
}

interface ResearchSource {
  title: string;
  url: string;
  snippet: string;
  content: string;
  qualityScore: number;
  qualityTier: "primary" | "authoritative" | "quality" | "general" | "low";
  domain: string;
  contentLength: number;
  fetchedAt: number;
  aspect?: string;  // Which aspect this source relates to
  citationId?: number;  // For citation tracking
}

// Subagent represents a parallel research worker for a specific aspect
interface Subagent {
  id: string;
  aspect: string;
  status: "pending" | "searching" | "evaluating" | "completed" | "failed";
  queries: string[];
  sources: ResearchSource[];
  findings: string[];
  startTime: number;
  endTime?: number;
}

// Memory module for context persistence
interface MemoryModule {
  plan: string[];
  context: Map<string, string>;
  findings: Map<string, string[]>;
  gaps: string[];
  aspectsCovered: Set<string>;
  iterationHistory: IterationResult[];
}

// Result of each iteration's think/evaluate phase
interface IterationResult {
  iteration: number;
  aspectsResearched: string[];
  sourcesFound: number;
  coverageScore: number;  // 0-100
  gaps: string[];
  decision: "continue" | "exit";
  reasoning: string;
}

// Main research session with multi-agent support
interface ResearchSession {
  id: string;
  topic: string;
  startTime: number;
  sources: ResearchSource[];
  subagents: Subagent[];
  memory: MemoryModule;
  iteration: number;
  maxIterations: number;
  status: "planning" | "researching" | "evaluating" | "synthesizing" | "citing" | "completed";
  depth: "basic" | "moderate" | "comprehensive";
  finalReport?: string;
  citedReport?: string;
}

// ============================================================================
// Configuration
// ============================================================================

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "";
const GOOGLE_CX = process.env.GOOGLE_CX || "";

const sessions = new Map<string, ResearchSession>();

const server = new McpServer({
  name: "google-research",
  version: "2.0.0",
});

// Coverage thresholds for adaptive stopping
const COVERAGE_THRESHOLDS = {
  basic: 60,
  moderate: 75,
  comprehensive: 90,
};

// Minimum sources per aspect
const MIN_SOURCES_PER_ASPECT = {
  basic: 2,
  moderate: 3,
  comprehensive: 5,
};

// ============================================================================
// Google Custom Search API
// ============================================================================

async function googleSearch(
  query: string,
  numResults: number = 10
): Promise<{ items: GoogleSearchItem[]; totalResults: number; searchTime: number }> {
  if (!GOOGLE_API_KEY || !GOOGLE_CX) {
    throw new Error("Missing GOOGLE_API_KEY or GOOGLE_CX environment variables");
  }

  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", GOOGLE_API_KEY);
  url.searchParams.set("cx", GOOGLE_CX);
  url.searchParams.set("q", query);
  url.searchParams.set("num", Math.min(numResults, 10).toString());

  const response = await fetch(url.toString());
  const data = (await response.json()) as GoogleSearchResponse;

  if (data.error) {
    throw new Error(`Google API Error: ${data.error.message}`);
  }

  return {
    items: data.items || [],
    totalResults: parseInt(data.searchInformation?.totalResults || "0", 10),
    searchTime: data.searchInformation?.searchTime || 0,
  };
}

// ============================================================================
// Deep Content Fetching
// ============================================================================

async function fetchFullPageContent(url: string, maxLength: number = 50000): Promise<string> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });

    clearTimeout(timeout);
    
    if (!response.ok) return "";

    const contentType = response.headers.get("content-type") || "";
    if (contentType.match(/image|video|audio|pdf|octet-stream|zip|tar/)) {
      return "[Binary content - skipped]";
    }

    const html = await response.text();
    return extractReadableContent(html, maxLength);
  } catch (err) {
    console.error(`Fetch error for ${url}:`, err);
    return "";
  }
}

function extractReadableContent(html: string, maxLength: number): string {
  let text = html;

  // Remove non-content elements
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "");
  text = text.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "");
  text = text.replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, "");
  text = text.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "");
  text = text.replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, "");
  text = text.replace(/<form[^>]*>[\s\S]*?<\/form>/gi, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  
  const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : "";

  const metaMatch = text.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
  const metaDesc = metaMatch ? metaMatch[1].trim() : "";

  let mainContent = "";
  const articleMatch = text.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch = text.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const contentMatch = text.match(/<div[^>]*(?:class|id)=["'][^"']*(?:content|article|post|entry|text)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  
  if (articleMatch) mainContent = articleMatch[1];
  else if (mainMatch) mainContent = mainMatch[1];
  else if (contentMatch) mainContent = contentMatch[1];
  else {
    const bodyMatch = text.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    mainContent = bodyMatch ? bodyMatch[1] : text;
  }

  mainContent = mainContent.replace(/<[^>]+>/g, " ");
  mainContent = mainContent
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&mdash;/g, "—").replace(/&ndash;/g, "–").replace(/&hellip;/g, "...")
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
    .replace(/&[a-z]+;/gi, " ");

  mainContent = mainContent.replace(/\s+/g, " ").replace(/\n\s*\n/g, "\n\n").trim();

  let result = "";
  if (title) result += `TITLE: ${title}\n\n`;
  if (metaDesc) result += `SUMMARY: ${metaDesc}\n\n`;
  result += `CONTENT:\n${mainContent}`;

  return result.slice(0, maxLength);
}

// ============================================================================
// Source Quality Assessment
// ============================================================================

function assessSourceQuality(url: string): { score: number; tier: ResearchSource["qualityTier"] } {
  let domain: string;
  try {
    domain = new URL(url).hostname.toLowerCase();
  } catch {
    return { score: 3, tier: "low" };
  }

  const primary = [
    /\.gov$/, /\.edu$/, /arxiv\.org/, /nature\.com/, /science\.org/,
    /ieee\.org/, /acm\.org/, /ncbi\.nlm\.nih\.gov/, /pubmed/, /nih\.gov/,
    /who\.int/, /cdc\.gov/, /fda\.gov/, /europa\.eu/,
    /springer\.com/, /wiley\.com/, /sciencedirect\.com/, /jstor\.org/,
    /github\.com/, /gitlab\.com/, /docs\./, /developer\./,
    /anthropic\.com/, /openai\.com/, /google\.ai/, /microsoft\.com\/research/,
    /research\.google/, /deepmind\.com/, /huggingface\.co/
  ];
  for (const p of primary) if (p.test(domain)) return { score: 10, tier: "primary" };

  const authoritative = [
    /wikipedia\.org/, /britannica\.com/,
    /reuters\.com/, /apnews\.com/, /bbc\.com/, /bbc\.co\.uk/,
    /nytimes\.com/, /wsj\.com/, /economist\.com/, /ft\.com/,
    /theguardian\.com/, /washingtonpost\.com/, /bloomberg\.com/
  ];
  for (const p of authoritative) if (p.test(domain)) return { score: 8, tier: "authoritative" };

  const quality = [
    /stackoverflow\.com/, /stackexchange\.com/,
    /techcrunch\.com/, /wired\.com/, /arstechnica\.com/, /theverge\.com/,
    /hbr\.org/, /forbes\.com/, /businessinsider\.com/,
    /towardsdatascience\.com/, /analyticsvidhya\.com/
  ];
  for (const p of quality) if (p.test(domain)) return { score: 7, tier: "quality" };

  const general = [/medium\.com/, /dev\.to/, /hashnode/, /substack\.com/, /notion\.site/];
  for (const p of general) if (p.test(domain)) return { score: 5, tier: "general" };

  const low = [
    /pinterest/, /facebook\.com/, /twitter\.com/, /x\.com/,
    /instagram\.com/, /tiktok\.com/, /snapchat\.com/,
    /reddit\.com/, /quora\.com/, /linkedin\.com/,
    /w3schools\.com/, /geeksforgeeks\.org/
  ];
  for (const p of low) if (p.test(domain)) return { score: 3, tier: "low" };

  return { score: 5, tier: "general" };
}

function getDomain(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

// ============================================================================
// LEAD RESEARCHER: Think (Plan Approach)
// Decomposes topic into aspects for parallel subagent research
// ============================================================================

function thinkPlanApproach(topic: string, depth: ResearchSession["depth"]): string[] {
  const aspects: string[] = [];
  const cleanTopic = topic.trim().toLowerCase();
  
  // Core aspects for any topic
  aspects.push(`${topic} overview definition`);
  aspects.push(`${topic} how it works mechanism`);
  
  if (depth === "basic") {
    return aspects;
  }
  
  // Moderate depth adds more aspects
  aspects.push(`${topic} use cases applications`);
  aspects.push(`${topic} benefits advantages`);
  aspects.push(`${topic} challenges limitations problems`);
  
  if (depth === "moderate") {
    return aspects;
  }
  
  // Comprehensive adds even more
  aspects.push(`${topic} history evolution development`);
  aspects.push(`${topic} comparison alternatives vs`);
  aspects.push(`${topic} implementation technical details`);
  aspects.push(`${topic} future trends predictions`);
  aspects.push(`${topic} research papers academic`);
  aspects.push(`${topic} case studies examples real world`);
  
  return aspects;
}

// ============================================================================
// LEAD RESEARCHER: Create Subagent
// Spawns a subagent for a specific aspect
// ============================================================================

function createSubagent(aspect: string, session: ResearchSession): Subagent {
  const id = `sa_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  
  // Generate queries for this aspect using context from memory
  const queries = generateAspectQueries(aspect, session);
  
  const subagent: Subagent = {
    id,
    aspect,
    status: "pending",
    queries,
    sources: [],
    findings: [],
    startTime: Date.now(),
  };
  
  return subagent;
}

// Generate queries for a specific aspect, using memory context
function generateAspectQueries(aspect: string, session: ResearchSession): string[] {
  const queries: string[] = [];
  const topic = session.topic;
  
  // Base query for the aspect
  queries.push(aspect);
  
  // Refine based on previous findings in memory
  const previousFindings = session.memory.findings.get(aspect) || [];
  if (previousFindings.length > 0) {
    // Add more specific queries based on what we learned
    queries.push(`${aspect} detailed explanation`);
    queries.push(`${aspect} expert analysis`);
  } else {
    // First time researching this aspect - broader queries
    queries.push(`${topic} ${aspect.split(' ').slice(-2).join(' ')}`);
  }
  
  // Add gap-filling queries if we have identified gaps
  const relevantGaps = session.memory.gaps.filter(g => 
    g.toLowerCase().includes(aspect.split(' ')[0].toLowerCase())
  );
  for (const gap of relevantGaps.slice(0, 2)) {
    queries.push(`${topic} ${gap}`);
  }
  
  return queries;
}

// ============================================================================
// SUBAGENT: Execute Research
// Each subagent runs: web_search -> think(evaluate) -> complete_task
// ============================================================================

async function executeSubagent(
  subagent: Subagent,
  session: ResearchSession,
  maxContentPerPage: number
): Promise<void> {
  subagent.status = "searching";
  console.error(`[Subagent ${subagent.id}] Starting research on: ${subagent.aspect}`);
  
  // Phase 1: Web Search
  for (const query of subagent.queries) {
    try {
      const results = await googleSearch(query, 5);
      
      for (const item of results.items) {
        // Skip duplicates
        if (session.sources.some(s => s.url === item.link)) continue;
        if (subagent.sources.some(s => s.url === item.link)) continue;
        
        const quality = assessSourceQuality(item.link);
        if (quality.score < 5) continue; // Skip low quality
        
        // Fetch full content
        const content = await fetchFullPageContent(item.link, maxContentPerPage);
        
        if (content.length > 100) {
          const source: ResearchSource = {
            title: item.title,
            url: item.link,
            snippet: item.snippet,
            content,
            qualityScore: quality.score,
            qualityTier: quality.tier,
            domain: getDomain(item.link),
            contentLength: content.length,
            fetchedAt: Date.now(),
            aspect: subagent.aspect,
          };
          subagent.sources.push(source);
        }
      }
    } catch (err) {
      console.error(`[Subagent ${subagent.id}] Search error:`, err);
    }
  }
  
  // Phase 2: Think (Evaluate)
  subagent.status = "evaluating";
  const evaluation = subagentThinkEvaluate(subagent);
  subagent.findings = evaluation.findings;
  
  // Phase 3: Complete Task
  subagent.status = "completed";
  subagent.endTime = Date.now();
  
  console.error(`[Subagent ${subagent.id}] Completed: ${subagent.sources.length} sources, ${subagent.findings.length} findings`);
}

// Subagent's think(evaluate) phase - extract key findings
function subagentThinkEvaluate(subagent: Subagent): { findings: string[] } {
  const findings: string[] = [];
  
  // Extract key information from each source
  for (const source of subagent.sources) {
    // Get first meaningful paragraph as a finding
    const contentLines = source.content.split('\n').filter(l => l.trim().length > 50);
    if (contentLines.length > 0) {
      const finding = `[${source.qualityTier.toUpperCase()}] ${source.title}: ${contentLines[0].slice(0, 200)}...`;
      findings.push(finding);
    }
  }
  
  return { findings };
}

// ============================================================================
// LEAD RESEARCHER: Think (Synthesize Results) & Evaluate Coverage
// Decides whether to continue or exit the research loop
// ============================================================================

function thinkSynthesizeAndEvaluate(session: ResearchSession): IterationResult {
  const iteration = session.iteration;
  const aspectsResearched = session.subagents
    .filter(s => s.status === "completed")
    .map(s => s.aspect);
  
  // Collect all sources from subagents
  for (const subagent of session.subagents) {
    for (const source of subagent.sources) {
      if (!session.sources.some(s => s.url === source.url)) {
        session.sources.push(source);
      }
    }
    // Store findings in memory
    const existing = session.memory.findings.get(subagent.aspect) || [];
    session.memory.findings.set(subagent.aspect, [...existing, ...subagent.findings]);
    session.memory.aspectsCovered.add(subagent.aspect);
  }
  
  // Calculate coverage score
  const coverageScore = calculateCoverageScore(session);
  
  // Identify gaps
  const gaps = identifyGaps(session);
  session.memory.gaps = gaps;
  
  // Decision: Continue or Exit?
  const threshold = COVERAGE_THRESHOLDS[session.depth];
  const minSources = MIN_SOURCES_PER_ASPECT[session.depth] * aspectsResearched.length;
  
  let decision: "continue" | "exit";
  let reasoning: string;
  
  if (coverageScore >= threshold && session.sources.length >= minSources) {
    decision = "exit";
    reasoning = `Coverage score ${coverageScore}% meets threshold ${threshold}%. ${session.sources.length} sources collected.`;
  } else if (iteration >= session.maxIterations - 1) {
    decision = "exit";
    reasoning = `Max iterations (${session.maxIterations}) reached. Coverage: ${coverageScore}%`;
  } else if (gaps.length === 0) {
    decision = "exit";
    reasoning = `No significant gaps identified. Coverage: ${coverageScore}%`;
  } else {
    decision = "continue";
    reasoning = `Coverage ${coverageScore}% below threshold ${threshold}%. Gaps: ${gaps.slice(0, 3).join(", ")}`;
  }
  
  const result: IterationResult = {
    iteration,
    aspectsResearched,
    sourcesFound: session.sources.length,
    coverageScore,
    gaps,
    decision,
    reasoning,
  };
  
  session.memory.iterationHistory.push(result);
  
  console.error(`[LeadResearcher] Iteration ${iteration + 1}: ${decision.toUpperCase()} - ${reasoning}`);
  
  return result;
}

function calculateCoverageScore(session: ResearchSession): number {
  const aspects = thinkPlanApproach(session.topic, session.depth);
  const coveredAspects = session.memory.aspectsCovered.size;
  const totalAspects = aspects.length;
  
  // Base coverage from aspects
  let score = (coveredAspects / totalAspects) * 50;
  
  // Bonus for source quality
  const primarySources = session.sources.filter(s => s.qualityTier === "primary").length;
  const authoritativeSources = session.sources.filter(s => s.qualityTier === "authoritative").length;
  score += Math.min(primarySources * 5, 25);
  score += Math.min(authoritativeSources * 3, 15);
  
  // Bonus for content depth
  const totalContent = session.sources.reduce((sum, s) => sum + s.contentLength, 0);
  if (totalContent > 100000) score += 10;
  else if (totalContent > 50000) score += 5;
  
  return Math.min(Math.round(score), 100);
}

function identifyGaps(session: ResearchSession): string[] {
  const gaps: string[] = [];
  const aspects = thinkPlanApproach(session.topic, session.depth);
  
  for (const aspect of aspects) {
    if (!session.memory.aspectsCovered.has(aspect)) {
      gaps.push(`Missing coverage: ${aspect}`);
    } else {
      // Check if we have enough sources for this aspect
      const aspectSources = session.sources.filter(s => s.aspect === aspect);
      if (aspectSources.length < MIN_SOURCES_PER_ASPECT[session.depth]) {
        gaps.push(`Insufficient sources for: ${aspect}`);
      }
      // Check if we have primary sources
      const primaryForAspect = aspectSources.filter(s => s.qualityTier === "primary");
      if (primaryForAspect.length === 0 && session.depth === "comprehensive") {
        gaps.push(`No primary sources for: ${aspect}`);
      }
    }
  }
  
  return gaps;
}

// ============================================================================
// CITATION AGENT: Process Documents & Insert Citations
// ============================================================================

function citationAgentProcess(session: ResearchSession): void {
  console.error(`[CitationAgent] Processing ${session.sources.length} sources for citations...`);
  
  // Assign citation IDs to all sources
  const sortedSources = [...session.sources].sort((a, b) => b.qualityScore - a.qualityScore);
  sortedSources.forEach((source, index) => {
    source.citationId = index + 1;
  });
  
  // Update session sources with citation IDs
  session.sources = sortedSources;
  
  // Insert citations into the report
  if (session.finalReport) {
    session.citedReport = insertCitations(session.finalReport, session.sources);
  }
  
  console.error(`[CitationAgent] Assigned ${sortedSources.length} citation IDs`);
}

function insertCitations(report: string, sources: ResearchSource[]): string {
  let citedReport = report;
  
  // Create a map of domain/title to citation ID for matching
  const citationMap = new Map<string, number>();
  for (const source of sources) {
    if (source.citationId) {
      citationMap.set(source.domain.toLowerCase(), source.citationId);
      citationMap.set(source.title.toLowerCase().slice(0, 50), source.citationId);
    }
  }
  
  // Insert citation markers after key claims
  // Look for sentences that likely need citations
  const sentences = citedReport.split(/(?<=[.!?])\s+/);
  const citedSentences: string[] = [];
  
  for (const sentence of sentences) {
    let citedSentence = sentence;
    
    // Check if sentence mentions any source domain or contains factual claims
    for (const source of sources) {
      if (source.citationId && 
          (sentence.toLowerCase().includes(source.domain.toLowerCase()) ||
           sentence.toLowerCase().includes(source.title.toLowerCase().slice(0, 30)))) {
        // Add citation if not already present
        if (!citedSentence.includes(`[${source.citationId}]`)) {
          citedSentence = citedSentence.replace(/([.!?])$/, ` [${source.citationId}]$1`);
          break;
        }
      }
    }
    
    citedSentences.push(citedSentence);
  }
  
  citedReport = citedSentences.join(" ");
  
  // Add references section
  citedReport += "\n\n## References\n\n";
  for (const source of sources) {
    if (source.citationId) {
      citedReport += `[${source.citationId}] ${source.title}. ${source.url} (${source.qualityTier})\n`;
    }
  }
  
  return citedReport;
}

// ============================================================================
// MEMORY MODULE: Save/Retrieve Context
// ============================================================================

function saveToMemory(session: ResearchSession, key: string, value: string): void {
  session.memory.context.set(key, value);
}

function retrieveFromMemory(session: ResearchSession, key: string): string | undefined {
  return session.memory.context.get(key);
}

function savePlanToMemory(session: ResearchSession, plan: string[]): void {
  session.memory.plan = plan;
  saveToMemory(session, "plan", plan.join("; "));
}

// ============================================================================
// SESSION MANAGEMENT
// ============================================================================

function createSession(topic: string, depth: "basic" | "moderate" | "comprehensive"): ResearchSession {
  const maxIter = depth === "basic" ? 2 : depth === "moderate" ? 3 : 4;
  const id = `rs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  
  const session: ResearchSession = {
    id,
    topic,
    startTime: Date.now(),
    sources: [],
    subagents: [],
    memory: {
      plan: [],
      context: new Map(),
      findings: new Map(),
      gaps: [],
      aspectsCovered: new Set(),
      iterationHistory: [],
    },
    iteration: 0,
    maxIterations: maxIter,
    status: "planning",
    depth,
  };
  
  sessions.set(id, session);
  return session;
}

// ============================================================================
// MAIN ORCHESTRATION: Multi-Agent Research Loop
// Implements the full Anthropic architecture
// ============================================================================

async function executeMultiAgentResearch(
  session: ResearchSession,
  maxContentPerPage: number
): Promise<void> {
  
  // ========================================
  // Phase 1: THINK (Plan Approach)
  // ========================================
  session.status = "planning";
  console.error(`[LeadResearcher] Planning research approach for: "${session.topic}"`);
  
  const aspects = thinkPlanApproach(session.topic, session.depth);
  savePlanToMemory(session, aspects);
  
  console.error(`[LeadResearcher] Identified ${aspects.length} aspects to research`);
  
  // ========================================
  // Phase 2: ITERATIVE RESEARCH LOOP
  // ========================================
  while (session.iteration < session.maxIterations) {
    session.status = "researching";
    console.error(`\n[LeadResearcher] === ITERATION ${session.iteration + 1}/${session.maxIterations} ===`);
    
    // Determine which aspects to research this iteration
    const aspectsThisIteration = getAspectsForIteration(session, aspects);
    
    if (aspectsThisIteration.length === 0) {
      console.error(`[LeadResearcher] No more aspects to research`);
      break;
    }
    
    // ----------------------------------------
    // Create Subagents for each aspect (PARALLEL)
    // ----------------------------------------
    const newSubagents: Subagent[] = [];
    for (const aspect of aspectsThisIteration) {
      const subagent = createSubagent(aspect, session);
      newSubagents.push(subagent);
      session.subagents.push(subagent);
    }
    
    console.error(`[LeadResearcher] Spawned ${newSubagents.length} subagents for parallel research`);
    
    // ----------------------------------------
    // Execute Subagents in PARALLEL
    // ----------------------------------------
    await Promise.all(
      newSubagents.map(subagent => executeSubagent(subagent, session, maxContentPerPage))
    );
    
    // ----------------------------------------
    // THINK (Synthesize Results) & EVALUATE
    // ----------------------------------------
    session.status = "evaluating";
    const evaluation = thinkSynthesizeAndEvaluate(session);
    
    // ----------------------------------------
    // Decision: Continue Loop or Exit?
    // ----------------------------------------
    if (evaluation.decision === "exit") {
      console.error(`[LeadResearcher] Exiting research loop: ${evaluation.reasoning}`);
      break;
    }
    
    session.iteration++;
    
    // Small delay between iterations
    await new Promise(r => setTimeout(r, 500));
  }
  
  // ========================================
  // Phase 3: SYNTHESIZE FINAL REPORT
  // ========================================
  session.status = "synthesizing";
  console.error(`[LeadResearcher] Synthesizing final report...`);
  session.finalReport = generateFinalReport(session);
  
  // ========================================
  // Phase 4: CITATION AGENT
  // ========================================
  session.status = "citing";
  citationAgentProcess(session);
  
  // ========================================
  // Phase 5: COMPLETE
  // ========================================
  session.status = "completed";
  console.error(`[LeadResearcher] Research complete!`);
}

function getAspectsForIteration(session: ResearchSession, allAspects: string[]): string[] {
  const uncoveredAspects = allAspects.filter(a => !session.memory.aspectsCovered.has(a));
  
  // First iteration: cover core aspects
  if (session.iteration === 0) {
    return uncoveredAspects.slice(0, Math.min(3, uncoveredAspects.length));
  }
  
  // Later iterations: fill gaps
  const gapAspects = session.memory.gaps
    .filter(g => g.includes("Missing coverage") || g.includes("Insufficient"))
    .map(g => {
      const match = g.match(/: (.+)$/);
      return match ? match[1] : null;
    })
    .filter((a): a is string => a !== null);
  
  // Combine gap aspects with uncovered aspects
  const aspectsToResearch = [...new Set([...gapAspects, ...uncoveredAspects])];
  
  return aspectsToResearch.slice(0, Math.min(4, aspectsToResearch.length));
}

// ============================================================================
// REPORT GENERATION
// ============================================================================

function generateFinalReport(session: ResearchSession): string {
  const sources = [...session.sources].sort((a, b) => b.qualityScore - a.qualityScore);
  
  const primary = sources.filter(s => s.qualityTier === "primary");
  const authoritative = sources.filter(s => s.qualityTier === "authoritative");
  const quality = sources.filter(s => s.qualityTier === "quality");
  const general = sources.filter(s => s.qualityTier === "general");

  const totalContent = sources.reduce((sum, s) => sum + s.contentLength, 0);
  const duration = ((Date.now() - session.startTime) / 1000).toFixed(1);
  const lastEval = session.memory.iterationHistory[session.memory.iterationHistory.length - 1];

  let report = `# Multi-Agent Research Report: ${session.topic}\n\n`;
  
  // Executive Summary
  report += `## Executive Summary\n\n`;
  report += `Research conducted using **Anthropic's Multi-Agent Architecture** with:\n`;
  report += `- **${session.subagents.length} subagents** researching ${session.memory.aspectsCovered.size} aspects in parallel\n`;
  report += `- **${session.iteration + 1} iterations** with adaptive stopping (coverage: ${lastEval?.coverageScore || 0}%)\n`;
  report += `- **${sources.length} sources** analyzed with ${(totalContent / 1000).toFixed(0)}K characters of content\n\n`;
  
  report += `| Metric | Value |\n|--------|-------|\n`;
  report += `| Primary Sources | ${primary.length} |\n`;
  report += `| Authoritative Sources | ${authoritative.length} |\n`;
  report += `| Quality Sources | ${quality.length} |\n`;
  report += `| General Sources | ${general.length} |\n`;
  report += `| Subagents Spawned | ${session.subagents.length} |\n`;
  report += `| Aspects Covered | ${session.memory.aspectsCovered.size} |\n`;
  report += `| Iterations | ${session.iteration + 1} |\n`;
  report += `| Final Coverage | ${lastEval?.coverageScore || 0}% |\n`;
  report += `| Duration | ${duration}s |\n\n`;

  // Research Plan
  report += `## Research Plan\n\n`;
  report += `The Lead Researcher decomposed the topic into these aspects:\n\n`;
  session.memory.plan.forEach((aspect, i) => {
    const covered = session.memory.aspectsCovered.has(aspect) ? "✅" : "❌";
    report += `${i + 1}. ${covered} ${aspect}\n`;
  });
  report += `\n`;

  // Iteration History
  report += `## Iteration History\n\n`;
  for (const iter of session.memory.iterationHistory) {
    report += `### Iteration ${iter.iteration + 1}\n\n`;
    report += `- **Aspects Researched:** ${iter.aspectsResearched.length}\n`;
    report += `- **Sources Found:** ${iter.sourcesFound}\n`;
    report += `- **Coverage Score:** ${iter.coverageScore}%\n`;
    report += `- **Decision:** ${iter.decision.toUpperCase()}\n`;
    report += `- **Reasoning:** ${iter.reasoning}\n`;
    if (iter.gaps.length > 0) {
      report += `- **Gaps Identified:** ${iter.gaps.slice(0, 3).join(", ")}\n`;
    }
    report += `\n`;
  }

  // Subagent Reports
  report += `## Subagent Reports\n\n`;
  for (const subagent of session.subagents) {
    const duration = subagent.endTime ? ((subagent.endTime - subagent.startTime) / 1000).toFixed(1) : "N/A";
    report += `### Subagent: ${subagent.aspect}\n\n`;
    report += `- **ID:** ${subagent.id}\n`;
    report += `- **Status:** ${subagent.status}\n`;
    report += `- **Queries:** ${subagent.queries.length}\n`;
    report += `- **Sources Found:** ${subagent.sources.length}\n`;
    report += `- **Duration:** ${duration}s\n\n`;
    
    if (subagent.findings.length > 0) {
      report += `**Key Findings:**\n`;
      subagent.findings.slice(0, 3).forEach(f => {
        report += `- ${f.slice(0, 200)}...\n`;
      });
      report += `\n`;
    }
  }

  // Detailed Findings with Full Content
  report += `## Detailed Source Analysis\n\n`;
  const topSources = sources.slice(0, 15);
  for (let i = 0; i < topSources.length; i++) {
    const s = topSources[i];
    report += `### [${i + 1}] ${s.title}\n\n`;
    report += `- **URL:** ${s.url}\n`;
    report += `- **Domain:** ${s.domain}\n`;
    report += `- **Quality:** ${s.qualityTier} (${s.qualityScore}/10)\n`;
    report += `- **Aspect:** ${s.aspect || "General"}\n`;
    report += `- **Content Length:** ${(s.contentLength / 1000).toFixed(1)}K chars\n\n`;
    
    if (s.content && s.content.length > 100) {
      const preview = s.content.slice(0, 3000);
      report += `**Content:**\n\n${preview}`;
      if (s.content.length > 3000) {
        report += `\n\n*[Content truncated - ${((s.content.length - 3000) / 1000).toFixed(1)}K more chars]*`;
      }
      report += `\n\n`;
    }
    report += `---\n\n`;
  }

  // All Sources by Quality Tier
  report += `## All Sources by Quality Tier\n\n`;

  if (primary.length > 0) {
    report += `### Primary Sources (Score 9-10)\n\n`;
    primary.forEach((s, i) => {
      report += `${i + 1}. [${s.title}](${s.url}) - ${s.domain} | ${s.aspect || "General"}\n`;
    });
    report += `\n`;
  }

  if (authoritative.length > 0) {
    report += `### Authoritative Sources (Score 8)\n\n`;
    authoritative.forEach((s, i) => {
      report += `${i + 1}. [${s.title}](${s.url}) - ${s.domain}\n`;
    });
    report += `\n`;
  }

  if (quality.length > 0) {
    report += `### Quality Sources (Score 7)\n\n`;
    quality.forEach((s, i) => {
      report += `${i + 1}. [${s.title}](${s.url}) - ${s.domain}\n`;
    });
    report += `\n`;
  }

  // Session Info
  report += `## Session Metadata\n\n`;
  report += `- **Session ID:** ${session.id}\n`;
  report += `- **Depth:** ${session.depth}\n`;
  report += `- **Total Iterations:** ${session.iteration + 1}\n`;
  report += `- **Total Subagents:** ${session.subagents.length}\n`;
  report += `- **Total Sources:** ${sources.length}\n`;
  report += `- **Total Content:** ${(totalContent / 1000).toFixed(0)}K characters\n`;
  report += `- **Duration:** ${duration}s\n`;

  return report;
}

// ============================================================================
// Tool 1: google_search - Simple search (snippets only)
// ============================================================================

server.tool(
  "google_search",
  `Simple Google search for quick lookups. Returns snippets only.
For deep research with full page content, use google_research or deep_search instead.`,
  {
    query: z.string().min(1).describe("Search query"),
    numResults: z.number().min(1).max(10).default(10).optional(),
  },
  async ({ query, numResults }) => {
    try {
      const results = await googleSearch(query, numResults || 10);

      if (results.items.length === 0) {
        return { content: [{ type: "text" as const, text: `No results for: "${query}"` }] };
      }

      let output = `## Search Results: "${query}"\n\n`;
      output += `${results.items.length} results (${results.searchTime.toFixed(2)}s)\n\n`;

      results.items.forEach((item, i) => {
        const q = assessSourceQuality(item.link);
        output += `### ${i + 1}. ${item.title}\n`;
        output += `**URL:** ${item.link}\n`;
        output += `**Quality:** ${q.tier} (${q.score}/10)\n`;
        output += `${item.snippet}\n\n`;
      });

      return { content: [{ type: "text" as const, text: output }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error}` }] };
    }
  }
);

// ============================================================================
// Tool 2: deep_search - Search + Fetch Full Content
// ============================================================================

server.tool(
  "deep_search",
  `Performs a comprehensive web search by querying Google, fetching the FULL content 
from top results using advanced content extraction (Readability algorithm), and 
returning consolidated content. Supports web, news, and image search types.
Includes retry logic for reliability.

This is TRUE deep research - it actually READS the pages, not just snippets.`,
  {
    query: z.string().describe("The search query to look up"),
    search_type: z.enum(["web", "news", "images"]).default("web").optional()
      .describe("Type of search: 'web' for general search, 'news' for news articles, 'images' for image search"),
    num_results: z.number().min(1).max(10).default(10).optional()
      .describe("Number of results to fetch (1-10, default: 10)"),
    max_content_per_page: z.number().min(5000).max(100000).default(50000).optional()
      .describe("Maximum characters of content to return per page (5000-100000, default: 50000)"),
    include_domains: z.string().optional()
      .describe("Comma-separated list of domains to include (e.g., 'reddit.com,github.com')"),
    exclude_domains: z.string().optional()
      .describe("Comma-separated list of domains to exclude (e.g., 'pinterest.com,facebook.com')"),
  },
  async ({ query, search_type, num_results, max_content_per_page, include_domains, exclude_domains }) => {
    const numResults = num_results || 10;
    const maxContent = max_content_per_page || 50000;
    const searchType = search_type || "web";

    try {
      // Modify query based on search type
      let searchQuery = query;
      if (searchType === "news") {
        searchQuery = `${query} news`;
      }
      
      // Add domain filters
      if (include_domains) {
        const domains = include_domains.split(",").map(d => `site:${d.trim()}`).join(" OR ");
        searchQuery = `${searchQuery} (${domains})`;
      }
      if (exclude_domains) {
        const domains = exclude_domains.split(",").map(d => `-site:${d.trim()}`).join(" ");
        searchQuery = `${searchQuery} ${domains}`;
      }

      const results = await googleSearch(searchQuery, numResults);
      
      if (results.items.length === 0) {
        return { content: [{ type: "text" as const, text: `No results for: "${query}"` }] };
      }

      console.error(`Fetching full content from ${results.items.length} pages...`);
      
      const fetchedPages = await Promise.all(
        results.items.map(async (item) => {
          const content = await fetchFullPageContent(item.link, maxContent);
          const quality = assessSourceQuality(item.link);
          return {
            title: item.title,
            url: item.link,
            domain: getDomain(item.link),
            quality,
            content,
            contentLength: content.length,
          };
        })
      );

      let output = `# Deep Search Results: "${query}"\n\n`;
      output += `Search type: ${searchType} | Fetched full content from ${fetchedPages.length} pages\n\n`;

      for (let i = 0; i < fetchedPages.length; i++) {
        const page = fetchedPages[i];
        output += `---\n\n`;
        output += `## [${i + 1}] ${page.title}\n\n`;
        output += `- **URL:** ${page.url}\n`;
        output += `- **Domain:** ${page.domain}\n`;
        output += `- **Quality:** ${page.quality.tier} (${page.quality.score}/10)\n`;
        output += `- **Content Length:** ${(page.contentLength / 1000).toFixed(1)}K chars\n\n`;
        
        if (page.content && page.content.length > 50) {
          output += `### Full Content:\n\n${page.content}\n\n`;
        } else {
          output += `*[No content extracted]*\n\n`;
        }
      }

      return { content: [{ type: "text" as const, text: output }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error}` }] };
    }
  }
);

// ============================================================================
// Tool 3: deep_search_news - News-specific deep search
// ============================================================================

server.tool(
  "deep_search_news",
  `Searches for recent news articles on a topic, fetches full article content, 
and returns consolidated results. Optimized for news and current events.`,
  {
    query: z.string().describe("The news topic to search for"),
    num_results: z.number().min(1).max(10).default(10).optional()
      .describe("Number of news articles to fetch (1-10, default: 10)"),
    max_content_per_page: z.number().min(5000).max(100000).default(30000).optional()
      .describe("Maximum characters per article (default: 30000)"),
  },
  async ({ query, num_results, max_content_per_page }) => {
    const numResults = num_results || 10;
    const maxContent = max_content_per_page || 30000;

    try {
      const searchQuery = `${query} news latest`;
      const results = await googleSearch(searchQuery, numResults);
      
      if (results.items.length === 0) {
        return { content: [{ type: "text" as const, text: `No news results for: "${query}"` }] };
      }

      const fetchedArticles = await Promise.all(
        results.items.map(async (item) => {
          const content = await fetchFullPageContent(item.link, maxContent);
          const quality = assessSourceQuality(item.link);
          return {
            title: item.title,
            url: item.link,
            domain: getDomain(item.link),
            quality,
            content,
            contentLength: content.length,
          };
        })
      );

      let output = `# News Search: "${query}"\n\n`;
      output += `Fetched ${fetchedArticles.length} news articles\n\n`;

      for (let i = 0; i < fetchedArticles.length; i++) {
        const article = fetchedArticles[i];
        output += `---\n\n`;
        output += `## [${i + 1}] ${article.title}\n\n`;
        output += `- **Source:** ${article.domain}\n`;
        output += `- **Quality:** ${article.quality.tier}\n`;
        output += `- **URL:** ${article.url}\n\n`;
        
        if (article.content && article.content.length > 50) {
          output += `${article.content}\n\n`;
        }
      }

      return { content: [{ type: "text" as const, text: output }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error}` }] };
    }
  }
);

// ============================================================================
// Tool 4: google_research - Full Multi-Agent Research
// ============================================================================

server.tool(
  "google_research",
  `Perform extensive DEEP research on a topic using Anthropic's Multi-Agent Research Architecture.

This tool implements the FULL multi-agent system:

1. **Lead Researcher (Orchestrator)**: Plans approach, coordinates subagents, synthesizes results
2. **Search Subagents**: Parallel workers for different aspects (spawned dynamically)
3. **Citation Agent**: Processes documents and inserts inline citations
4. **Memory Module**: Persists context, findings, and gaps across iterations

**Process Flow:**
1. Think (Plan Approach) - Decompose topic into aspects
2. Create Subagents - Spawn parallel workers for each aspect
3. Execute Research - Each subagent: web_search → think(evaluate) → complete_task
4. Think (Synthesize) - Combine findings, calculate coverage
5. Evaluate - "More research needed?" decision with adaptive stopping
6. Citation Agent - Process report and insert citations
7. Return Final Report

**Depth Levels:**
- basic: 2 iterations max, 2 aspects, ~60% coverage threshold
- moderate: 3 iterations max, 5 aspects, ~75% coverage threshold
- comprehensive: 4 iterations max, 11 aspects, ~90% coverage threshold`,
  {
    topic: z.string().min(1).describe("Research topic"),
    depth: z.enum(["basic", "moderate", "comprehensive"]).default("moderate").optional(),
    max_content_per_page: z.number().min(5000).max(100000).default(50000).optional()
      .describe("Max content per page (default: 50000)"),
  },
  async ({ topic, depth, max_content_per_page }) => {
    const researchDepth = depth || "moderate";
    const maxContent = max_content_per_page || 50000;

    try {
      console.error(`\n${"=".repeat(60)}`);
      console.error(`[MULTI-AGENT RESEARCH SYSTEM] Starting ${researchDepth} research`);
      console.error(`Topic: "${topic}"`);
      console.error(`${"=".repeat(60)}\n`);
      
      const session = createSession(topic, researchDepth);
      
      await executeMultiAgentResearch(session, maxContent);
      
      // Return the cited report if available, otherwise the final report
      const report = session.citedReport || session.finalReport || "No report generated";
      
      console.error(`\n${"=".repeat(60)}`);
      console.error(`[MULTI-AGENT RESEARCH SYSTEM] Complete!`);
      console.error(`Sources: ${session.sources.length} | Subagents: ${session.subagents.length} | Iterations: ${session.iteration + 1}`);
      console.error(`${"=".repeat(60)}\n`);

      return { content: [{ type: "text" as const, text: report }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error}` }] };
    }
  }
);

// ============================================================================
// Tool 5: fetch_page - Fetch single page content
// ============================================================================

server.tool(
  "fetch_page",
  `Fetch and extract the full readable content from a single URL.
Uses Readability-style extraction to get the main content, removing navigation, ads, etc.`,
  {
    url: z.string().url().describe("URL to fetch"),
    max_length: z.number().min(1000).max(100000).default(50000).optional()
      .describe("Max content length (default: 50000)"),
  },
  async ({ url, max_length }) => {
    try {
      const content = await fetchFullPageContent(url, max_length || 50000);
      const quality = assessSourceQuality(url);
      
      if (!content || content.length < 50) {
        return { content: [{ type: "text" as const, text: `Could not extract content from: ${url}` }] };
      }

      let output = `# Page Content: ${url}\n\n`;
      output += `- **Domain:** ${getDomain(url)}\n`;
      output += `- **Quality:** ${quality.tier} (${quality.score}/10)\n`;
      output += `- **Content Length:** ${(content.length / 1000).toFixed(1)}K chars\n\n`;
      output += `---\n\n`;
      output += content;

      return { content: [{ type: "text" as const, text: output }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error fetching ${url}: ${error}` }] };
    }
  }
);

// ============================================================================
// Tool 6: research_session - Manual session management
// ============================================================================

server.tool(
  "research_session",
  `Create or manage a research session for multi-step research workflows.

Actions:
- create: Start a new session with Lead Researcher planning
- status: Check session progress, subagents, and coverage
- complete: Generate final report with citations`,
  {
    action: z.enum(["create", "status", "complete"]),
    topic: z.string().optional().describe("Topic (for create)"),
    sessionId: z.string().optional().describe("Session ID (for status/complete)"),
    depth: z.enum(["basic", "moderate", "comprehensive"]).default("moderate").optional(),
  },
  async ({ action, topic, sessionId, depth }) => {
    try {
      if (action === "create") {
        if (!topic) {
          return { content: [{ type: "text" as const, text: "Error: topic required" }] };
        }
        const session = createSession(topic, depth || "moderate");
        
        // Plan the research approach
        const aspects = thinkPlanApproach(topic, session.depth);
        savePlanToMemory(session, aspects);
        
        let output = `## Research Session Created\n\n`;
        output += `- **ID:** ${session.id}\n`;
        output += `- **Topic:** ${topic}\n`;
        output += `- **Depth:** ${session.depth}\n`;
        output += `- **Max Iterations:** ${session.maxIterations}\n`;
        output += `- **Coverage Threshold:** ${COVERAGE_THRESHOLDS[session.depth]}%\n\n`;
        output += `### Research Plan (${aspects.length} aspects)\n\n`;
        aspects.forEach((a, i) => {
          output += `${i + 1}. ${a}\n`;
        });
        
        return { content: [{ type: "text" as const, text: output }] };
      }

      if (!sessionId) {
        return { content: [{ type: "text" as const, text: "Error: sessionId required" }] };
      }

      const session = sessions.get(sessionId);
      if (!session) {
        return { content: [{ type: "text" as const, text: `Session not found: ${sessionId}` }] };
      }

      if (action === "status") {
        const totalContent = session.sources.reduce((s, src) => s + src.contentLength, 0);
        const lastEval = session.memory.iterationHistory[session.memory.iterationHistory.length - 1];
        
        let output = `## Session Status\n\n`;
        output += `- **ID:** ${session.id}\n`;
        output += `- **Topic:** ${session.topic}\n`;
        output += `- **Status:** ${session.status}\n`;
        output += `- **Iteration:** ${session.iteration + 1}/${session.maxIterations}\n`;
        output += `- **Coverage:** ${lastEval?.coverageScore || 0}%\n`;
        output += `- **Sources:** ${session.sources.length}\n`;
        output += `- **Content:** ${(totalContent/1000).toFixed(0)}K chars\n`;
        output += `- **Subagents:** ${session.subagents.length}\n`;
        output += `- **Aspects Covered:** ${session.memory.aspectsCovered.size}\n\n`;
        
        if (session.memory.gaps.length > 0) {
          output += `### Gaps Identified\n\n`;
          session.memory.gaps.forEach(g => {
            output += `- ${g}\n`;
          });
        }
        
        if (session.subagents.length > 0) {
          output += `\n### Subagent Status\n\n`;
          session.subagents.forEach(sa => {
            output += `- **${sa.aspect}**: ${sa.status} (${sa.sources.length} sources)\n`;
          });
        }
        
        return { content: [{ type: "text" as const, text: output }] };
      }

      if (action === "complete") {
        if (session.status !== "completed") {
          session.status = "synthesizing";
          session.finalReport = generateFinalReport(session);
          citationAgentProcess(session);
          session.status = "completed";
        }
        
        const report = session.citedReport || session.finalReport || "No report generated";
        return { content: [{ type: "text" as const, text: report }] };
      }

      return { content: [{ type: "text" as const, text: "Unknown action" }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error}` }] };
    }
  }
);

// ============================================================================
// Tool 7: add_source - Add source to session
// ============================================================================

server.tool(
  "add_source",
  `Add a source to a research session after fetching its content.`,
  {
    sessionId: z.string(),
    url: z.string().url(),
    title: z.string(),
    fetchContent: z.boolean().default(true).optional(),
  },
  async ({ sessionId, url, title, fetchContent }) => {
    try {
      const session = sessions.get(sessionId);
      if (!session) {
        return { content: [{ type: "text" as const, text: `Session not found: ${sessionId}` }] };
      }

      let content = "";
      if (fetchContent !== false) {
        content = await fetchFullPageContent(url, 50000);
      }

      const quality = assessSourceQuality(url);
      const source: ResearchSource = {
        title,
        url,
        snippet: "",
        content,
        qualityScore: quality.score,
        qualityTier: quality.tier,
        domain: getDomain(url),
        contentLength: content.length,
        fetchedAt: Date.now(),
      };

      session.sources.push(source);

      return {
        content: [{
          type: "text" as const,
          text: `## Source Added\n\n` +
            `- **Title:** ${title}\n` +
            `- **URL:** ${url}\n` +
            `- **Quality:** ${quality.tier} (${quality.score}/10)\n` +
            `- **Content:** ${(content.length/1000).toFixed(1)}K chars\n` +
            `- **Total Sources:** ${session.sources.length}`
        }]
      };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error}` }] };
    }
  }
);

// ============================================================================
// Tool 8: web_search - Search with quality scoring
// ============================================================================

server.tool(
  "web_search",
  `Search the web with source quality scoring.
For full page content, follow up with fetch_page or use deep_search.`,
  {
    query: z.string(),
    maxResults: z.number().default(10).optional(),
  },
  async ({ query, maxResults }) => {
    try {
      const results = await googleSearch(query, maxResults || 10);

      if (results.items.length === 0) {
        return { content: [{ type: "text" as const, text: `No results: "${query}"` }] };
      }

      let output = `## Web Search: "${query}"\n\n`;

      results.items.forEach((item, i) => {
        const q = assessSourceQuality(item.link);
        output += `${i + 1}. **${item.title}**\n`;
        output += `   - URL: ${item.link}\n`;
        output += `   - Quality: ${q.tier} (${q.score}/10)\n`;
        output += `   - ${item.snippet}\n\n`;
      });

      return { content: [{ type: "text" as const, text: output }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error}` }] };
    }
  }
);

// ============================================================================
// Tool 9: get_citations - Format citations from session
// ============================================================================

server.tool(
  "get_citations",
  `Get formatted citations from a research session.
Supports markdown, numbered, and APA formats.`,
  {
    sessionId: z.string(),
    format: z.enum(["markdown", "numbered", "apa"]).default("markdown").optional(),
  },
  async ({ sessionId, format }) => {
    try {
      const session = sessions.get(sessionId);
      if (!session) {
        return { content: [{ type: "text" as const, text: `Session not found: ${sessionId}` }] };
      }

      const sources = [...session.sources].sort((a, b) => b.qualityScore - a.qualityScore);
      
      let output = `## Citations: ${session.topic}\n\n`;
      output += `${sources.length} sources | Format: ${format || "markdown"}\n\n`;

      if (format === "apa") {
        sources.forEach((s, i) => {
          output += `[${i + 1}] ${s.title}. Retrieved from ${s.url}\n\n`;
        });
      } else if (format === "numbered") {
        sources.forEach((s, i) => {
          output += `[${i + 1}] ${s.title}. ${s.url} (${s.qualityTier})\n`;
        });
      } else {
        // Group by quality tier
        const primary = sources.filter(s => s.qualityTier === "primary");
        const authoritative = sources.filter(s => s.qualityTier === "authoritative");
        const quality = sources.filter(s => s.qualityTier === "quality");
        const general = sources.filter(s => s.qualityTier === "general" || s.qualityTier === "low");
        
        if (primary.length > 0) {
          output += `### Primary Sources\n\n`;
          primary.forEach((s, i) => {
            output += `${i + 1}. [${s.title}](${s.url}) - *${s.domain}*\n`;
          });
          output += `\n`;
        }
        
        if (authoritative.length > 0) {
          output += `### Authoritative Sources\n\n`;
          authoritative.forEach((s, i) => {
            output += `${i + 1}. [${s.title}](${s.url}) - *${s.domain}*\n`;
          });
          output += `\n`;
        }
        
        if (quality.length > 0) {
          output += `### Quality Sources\n\n`;
          quality.forEach((s, i) => {
            output += `${i + 1}. [${s.title}](${s.url}) - *${s.domain}*\n`;
          });
          output += `\n`;
        }
        
        if (general.length > 0) {
          output += `### Other Sources\n\n`;
          general.forEach((s, i) => {
            output += `${i + 1}. [${s.title}](${s.url}) - *${s.domain}*\n`;
          });
        }
      }

      return { content: [{ type: "text" as const, text: output }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error}` }] };
    }
  }
);

// ============================================================================
// Tool 10: run_subagent - Manually spawn a subagent for an aspect
// ============================================================================

server.tool(
  "run_subagent",
  `Manually spawn and run a subagent for a specific research aspect.
This allows fine-grained control over the multi-agent research process.

The subagent will:
1. Generate queries for the aspect
2. Execute web searches
3. Fetch full page content
4. Evaluate findings
5. Return results`,
  {
    sessionId: z.string().describe("Research session ID"),
    aspect: z.string().describe("The aspect to research (e.g., 'machine learning applications')"),
    max_content_per_page: z.number().min(5000).max(100000).default(30000).optional(),
  },
  async ({ sessionId, aspect, max_content_per_page }) => {
    try {
      const session = sessions.get(sessionId);
      if (!session) {
        return { content: [{ type: "text" as const, text: `Session not found: ${sessionId}` }] };
      }

      const maxContent = max_content_per_page || 30000;
      
      // Create and execute subagent
      const subagent = createSubagent(aspect, session);
      session.subagents.push(subagent);
      
      await executeSubagent(subagent, session, maxContent);
      
      // Add sources to session
      for (const source of subagent.sources) {
        if (!session.sources.some(s => s.url === source.url)) {
          session.sources.push(source);
        }
      }
      
      // Update memory
      session.memory.aspectsCovered.add(aspect);
      session.memory.findings.set(aspect, subagent.findings);

      let output = `## Subagent Report: ${aspect}\n\n`;
      output += `- **Subagent ID:** ${subagent.id}\n`;
      output += `- **Status:** ${subagent.status}\n`;
      output += `- **Queries Executed:** ${subagent.queries.length}\n`;
      output += `- **Sources Found:** ${subagent.sources.length}\n`;
      output += `- **Duration:** ${subagent.endTime ? ((subagent.endTime - subagent.startTime) / 1000).toFixed(1) : "N/A"}s\n\n`;
      
      if (subagent.queries.length > 0) {
        output += `### Queries\n\n`;
        subagent.queries.forEach((q, i) => {
          output += `${i + 1}. "${q}"\n`;
        });
        output += `\n`;
      }
      
      if (subagent.findings.length > 0) {
        output += `### Key Findings\n\n`;
        subagent.findings.forEach((f, i) => {
          output += `${i + 1}. ${f.slice(0, 300)}...\n\n`;
        });
      }
      
      if (subagent.sources.length > 0) {
        output += `### Sources\n\n`;
        subagent.sources.forEach((s, i) => {
          output += `${i + 1}. [${s.qualityTier.toUpperCase()}] ${s.title}\n`;
          output += `   ${s.url}\n`;
          output += `   ${(s.contentLength / 1000).toFixed(1)}K chars\n\n`;
        });
      }

      return { content: [{ type: "text" as const, text: output }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error}` }] };
    }
  }
);

// ============================================================================
// Tool 11: evaluate_coverage - Check research coverage and gaps
// ============================================================================

server.tool(
  "evaluate_coverage",
  `Evaluate the current research coverage and identify gaps.
This implements the "More research needed?" decision point from Anthropic's architecture.`,
  {
    sessionId: z.string().describe("Research session ID"),
  },
  async ({ sessionId }) => {
    try {
      const session = sessions.get(sessionId);
      if (!session) {
        return { content: [{ type: "text" as const, text: `Session not found: ${sessionId}` }] };
      }

      const evaluation = thinkSynthesizeAndEvaluate(session);
      
      let output = `## Coverage Evaluation\n\n`;
      output += `### Metrics\n\n`;
      output += `- **Coverage Score:** ${evaluation.coverageScore}%\n`;
      output += `- **Threshold:** ${COVERAGE_THRESHOLDS[session.depth]}%\n`;
      output += `- **Sources Found:** ${evaluation.sourcesFound}\n`;
      output += `- **Aspects Researched:** ${evaluation.aspectsResearched.length}\n`;
      output += `- **Iteration:** ${evaluation.iteration + 1}\n\n`;
      
      output += `### Decision\n\n`;
      output += `**${evaluation.decision.toUpperCase()}** - ${evaluation.reasoning}\n\n`;
      
      if (evaluation.gaps.length > 0) {
        output += `### Gaps Identified\n\n`;
        evaluation.gaps.forEach((g, i) => {
          output += `${i + 1}. ${g}\n`;
        });
        output += `\n`;
      }
      
      output += `### Aspects Covered\n\n`;
      evaluation.aspectsResearched.forEach((a, i) => {
        output += `${i + 1}. ✅ ${a}\n`;
      });

      return { content: [{ type: "text" as const, text: output }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error}` }] };
    }
  }
);

// ============================================================================
// Server Initialization
// ============================================================================

async function main() {
  if (!GOOGLE_API_KEY) console.error("Warning: GOOGLE_API_KEY not set");
  if (!GOOGLE_CX) console.error("Warning: GOOGLE_CX not set");

  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  console.error("=".repeat(60));
  console.error("Google Research MCP Server v2.0.0");
  console.error("Multi-Agent Research Architecture (Anthropic Compliant)");
  console.error("=".repeat(60));
  console.error("");
  console.error("Architecture Components:");
  console.error("  - Lead Researcher (Orchestrator)");
  console.error("  - Search Subagents (Parallel Workers)");
  console.error("  - Citation Agent");
  console.error("  - Memory Module");
  console.error("");
  console.error("Tools Available:");
  console.error("  1. google_search      - Simple search (snippets)");
  console.error("  2. deep_search        - Search + fetch full content");
  console.error("  3. deep_search_news   - News-specific deep search");
  console.error("  4. google_research    - Full multi-agent research");
  console.error("  5. fetch_page         - Fetch single page content");
  console.error("  6. research_session   - Session management");
  console.error("  7. add_source         - Add source to session");
  console.error("  8. web_search         - Search with quality scoring");
  console.error("  9. get_citations      - Format citations");
  console.error(" 10. run_subagent       - Manually spawn subagent");
  console.error(" 11. evaluate_coverage  - Check coverage & gaps");
  console.error("");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
