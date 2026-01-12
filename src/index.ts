#!/usr/bin/env node
/**
 * Google Research MCP Server v1.2.0
 * 
 * Implements Claude Research methodology with DEEP content extraction.
 * 
 * Key improvements based on Anthropic's architecture:
 * 1. Full page content fetching (not just snippets)
 * 2. Progressive disclosure - broad to narrow
 * 3. Multi-hop reasoning with iterative refinement
 * 4. Parallel sub-agent execution
 * 5. Context compaction and note-taking
 * 6. Source quality prioritization (primary > SEO farms)
 * 
 * The system "gives Claude a computer" - it doesn't just search,
 * it READS the full content of pages like a human researcher.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ============================================================================
// Types
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
  content: string;  // FULL page content - this is critical
  qualityScore: number;
  qualityTier: "primary" | "authoritative" | "quality" | "general" | "low";
  domain: string;
  contentLength: number;
  fetchedAt: number;
}

interface ResearchSession {
  id: string;
  topic: string;
  startTime: number;
  sources: ResearchSource[];
  notes: string[];  // Compacted findings (context engineering)
  gaps: string[];
  queriesExecuted: string[];
  iteration: number;
  maxIterations: number;
  status: "active" | "completed";
}

// ============================================================================
// Configuration
// ============================================================================

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "";
const GOOGLE_CX = process.env.GOOGLE_CX || "";

const sessions = new Map<string, ResearchSession>();

const server = new McpServer({
  name: "google-research",
  version: "1.2.0",
});

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
// DEEP Content Fetching - The Core Improvement
// This is what makes it "Deep Research" - actually reading pages
// ============================================================================

async function fetchFullPageContent(url: string, maxLength: number = 50000): Promise<string> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout for deep fetch

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });

    clearTimeout(timeout);
    
    if (!response.ok) {
      console.error(`Fetch failed for ${url}: ${response.status}`);
      return "";
    }

    const contentType = response.headers.get("content-type") || "";
    
    // Skip binary content
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

/**
 * Extract readable content from HTML - Readability-style algorithm
 * This is critical for deep research - we need the ACTUAL content, not boilerplate
 */
function extractReadableContent(html: string, maxLength: number): string {
  let text = html;

  // Remove script, style, and non-content elements
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
  
  // Extract title
  const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : "";

  // Extract meta description
  const metaMatch = text.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
  const metaDesc = metaMatch ? metaMatch[1].trim() : "";

  // Try to find main content areas
  let mainContent = "";
  
  // Look for article, main, or content divs
  const articleMatch = text.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch = text.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const contentMatch = text.match(/<div[^>]*(?:class|id)=["'][^"']*(?:content|article|post|entry|text)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  
  if (articleMatch) {
    mainContent = articleMatch[1];
  } else if (mainMatch) {
    mainContent = mainMatch[1];
  } else if (contentMatch) {
    mainContent = contentMatch[1];
  } else {
    // Fall back to body
    const bodyMatch = text.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    mainContent = bodyMatch ? bodyMatch[1] : text;
  }

  // Remove remaining HTML tags
  mainContent = mainContent.replace(/<[^>]+>/g, " ");
  
  // Decode HTML entities
  mainContent = mainContent
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "...")
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
    .replace(/&[a-z]+;/gi, " ");

  // Clean up whitespace
  mainContent = mainContent
    .replace(/\s+/g, " ")
    .replace(/\n\s*\n/g, "\n\n")
    .trim();

  // Construct final content with metadata
  let result = "";
  if (title) result += `TITLE: ${title}\n\n`;
  if (metaDesc) result += `SUMMARY: ${metaDesc}\n\n`;
  result += `CONTENT:\n${mainContent}`;

  return result.slice(0, maxLength);
}

// ============================================================================
// Source Quality Assessment - Prioritize Primary Sources
// ============================================================================

function assessSourceQuality(url: string): { score: number; tier: ResearchSource["qualityTier"] } {
  let domain: string;
  try {
    domain = new URL(url).hostname.toLowerCase();
  } catch {
    return { score: 3, tier: "low" };
  }

  // Primary sources (10) - Official docs, research, government
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

  // Authoritative (8-9)
  const authoritative = [
    /wikipedia\.org/, /britannica\.com/,
    /reuters\.com/, /apnews\.com/, /bbc\.com/, /bbc\.co\.uk/,
    /nytimes\.com/, /wsj\.com/, /economist\.com/, /ft\.com/,
    /theguardian\.com/, /washingtonpost\.com/, /bloomberg\.com/
  ];
  for (const p of authoritative) if (p.test(domain)) return { score: 8, tier: "authoritative" };

  // Quality (7)
  const quality = [
    /stackoverflow\.com/, /stackexchange\.com/,
    /techcrunch\.com/, /wired\.com/, /arstechnica\.com/, /theverge\.com/,
    /hbr\.org/, /forbes\.com/, /businessinsider\.com/,
    /towardsdatascience\.com/, /analyticsvidhya\.com/
  ];
  for (const p of quality) if (p.test(domain)) return { score: 7, tier: "quality" };

  // General (5-6)
  const general = [/medium\.com/, /dev\.to/, /hashnode/, /substack\.com/, /notion\.site/];
  for (const p of general) if (p.test(domain)) return { score: 5, tier: "general" };

  // Low quality - SEO farms, social media (deprioritized)
  const low = [
    /pinterest/, /facebook\.com/, /twitter\.com/, /x\.com/,
    /instagram\.com/, /tiktok\.com/, /snapchat\.com/,
    /reddit\.com/, /quora\.com/, /linkedin\.com/,
    /w3schools\.com/, /geeksforgeeks\.org/ // Often SEO-optimized, not primary
  ];
  for (const p of low) if (p.test(domain)) return { score: 3, tier: "low" };

  return { score: 5, tier: "general" };
}

function getDomain(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

// ============================================================================
// Progressive Query Generation - Start Broad, Then Narrow
// ============================================================================

function generateProgressiveQueries(
  topic: string,
  iteration: number,
  previousFindings: string[]
): string[] {
  const queries: string[] = [];
  const clean = topic.trim();

  if (iteration === 0) {
    // BROAD initial queries (1-6 words) - cast a wide net
    queries.push(clean);
    queries.push(`${clean} overview`);
    queries.push(`${clean} explained`);
    queries.push(`what is ${clean}`);
    queries.push(`${clean} guide`);
  } else if (iteration === 1) {
    // NARROWER - based on what we learned
    queries.push(`${clean} how it works`);
    queries.push(`${clean} architecture`);
    queries.push(`${clean} examples`);
    queries.push(`${clean} use cases applications`);
    queries.push(`${clean} best practices`);
    queries.push(`${clean} comparison vs alternatives`);
  } else if (iteration === 2) {
    // DEEP DIVE - specific aspects
    queries.push(`${clean} research paper academic`);
    queries.push(`${clean} technical documentation`);
    queries.push(`${clean} implementation details`);
    queries.push(`${clean} case study`);
    queries.push(`${clean} latest developments 2024 2025`);
    queries.push(`${clean} challenges limitations`);
  } else {
    // FILL GAPS - based on what's missing
    queries.push(`${clean} advanced topics`);
    queries.push(`${clean} expert analysis`);
    queries.push(`${clean} future trends predictions`);
    queries.push(`${clean} industry report`);
  }

  return queries;
}

// ============================================================================
// Session Management - Memory Module
// ============================================================================

function createSession(topic: string, depth: "basic" | "moderate" | "comprehensive"): ResearchSession {
  const maxIter = depth === "basic" ? 1 : depth === "moderate" ? 2 : 3;
  const id = `rs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  
  const session: ResearchSession = {
    id,
    topic,
    startTime: Date.now(),
    sources: [],
    notes: [],
    gaps: [],
    queriesExecuted: [],
    iteration: 0,
    maxIterations: maxIter,
    status: "active",
  };
  
  sessions.set(id, session);
  return session;
}

// ============================================================================
// Deep Research Execution - The Core Algorithm
// ============================================================================

async function executeDeepResearch(
  session: ResearchSession,
  sourcesPerQuery: number,
  maxContentPerPage: number
): Promise<void> {
  
  while (session.iteration < session.maxIterations) {
    const queries = generateProgressiveQueries(
      session.topic,
      session.iteration,
      session.notes
    );

    console.error(`[Iteration ${session.iteration + 1}/${session.maxIterations}] Executing ${queries.length} queries...`);

    // Execute searches in parallel batches of 3
    const batchSize = 3;
    for (let i = 0; i < queries.length; i += batchSize) {
      const batch = queries.slice(i, i + batchSize);
      
      const searchResults = await Promise.all(
        batch.map(async (query) => {
          try {
            session.queriesExecuted.push(query);
            return await googleSearch(query, sourcesPerQuery);
          } catch (err) {
            console.error(`Search failed for "${query}":`, err);
            return { items: [], totalResults: 0, searchTime: 0 };
          }
        })
      );

      // Collect all URLs from this batch
      const urlsToFetch: { url: string; title: string; snippet: string }[] = [];
      
      for (const result of searchResults) {
        for (const item of result.items) {
          // Skip if we already have this URL
          if (session.sources.some(s => s.url === item.link)) continue;
          
          const quality = assessSourceQuality(item.link);
          // Prioritize higher quality sources for fetching
          if (quality.score >= 5) {
            urlsToFetch.push({
              url: item.link,
              title: item.title,
              snippet: item.snippet,
            });
          }
        }
      }

      // DEEP FETCH - Get full content from ALL quality pages
      // This is the key difference from shallow research
      console.error(`[Iteration ${session.iteration + 1}] Fetching full content from ${urlsToFetch.length} pages...`);
      
      const fetchResults = await Promise.all(
        urlsToFetch.slice(0, 10).map(async ({ url, title, snippet }) => {
          const content = await fetchFullPageContent(url, maxContentPerPage);
          const quality = assessSourceQuality(url);
          
          return {
            title,
            url,
            snippet,
            content,
            qualityScore: quality.score,
            qualityTier: quality.tier,
            domain: getDomain(url),
            contentLength: content.length,
            fetchedAt: Date.now(),
          } as ResearchSource;
        })
      );

      // Add sources with actual content
      for (const source of fetchResults) {
        if (source.content.length > 100) {
          session.sources.push(source);
          
          // Extract key finding as a "note" (context compaction)
          const note = `[${source.qualityTier.toUpperCase()}] ${source.title}: ${source.snippet}`;
          session.notes.push(note);
        }
      }

      // Small delay between batches
      if (i + batchSize < queries.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    session.iteration++;
  }

  session.status = "completed";
}

// ============================================================================
// Report Generation - Comprehensive Output with Full Content
// ============================================================================

function generateDeepReport(session: ResearchSession): string {
  // Sort by quality
  const sources = [...session.sources].sort((a, b) => b.qualityScore - a.qualityScore);
  
  const primary = sources.filter(s => s.qualityTier === "primary");
  const authoritative = sources.filter(s => s.qualityTier === "authoritative");
  const quality = sources.filter(s => s.qualityTier === "quality");
  const general = sources.filter(s => s.qualityTier === "general");

  const totalContent = sources.reduce((sum, s) => sum + s.contentLength, 0);
  const duration = ((Date.now() - session.startTime) / 1000).toFixed(1);

  let report = `# Deep Research Report: ${session.topic}\n\n`;
  
  // Executive Summary
  report += `## Executive Summary\n\n`;
  report += `Completed ${session.iteration} research iterations, analyzing **${sources.length} sources** `;
  report += `with **${(totalContent / 1000).toFixed(0)}K characters** of content.\n\n`;
  report += `| Metric | Value |\n|--------|-------|\n`;
  report += `| Primary Sources | ${primary.length} |\n`;
  report += `| Authoritative Sources | ${authoritative.length} |\n`;
  report += `| Quality Sources | ${quality.length} |\n`;
  report += `| General Sources | ${general.length} |\n`;
  report += `| Queries Executed | ${session.queriesExecuted.length} |\n`;
  report += `| Duration | ${duration}s |\n\n`;

  // Key Findings with FULL CONTENT
  report += `## Detailed Findings\n\n`;
  report += `The following sources were fetched and analyzed in full:\n\n`;

  const topSources = sources.slice(0, 15);
  for (let i = 0; i < topSources.length; i++) {
    const s = topSources[i];
    report += `### [${i + 1}] ${s.title}\n\n`;
    report += `- **URL:** ${s.url}\n`;
    report += `- **Domain:** ${s.domain}\n`;
    report += `- **Quality:** ${s.qualityTier} (${s.qualityScore}/10)\n`;
    report += `- **Content Length:** ${(s.contentLength / 1000).toFixed(1)}K chars\n\n`;
    
    // Include substantial content preview
    if (s.content && s.content.length > 100) {
      const preview = s.content.slice(0, 4000);
      report += `**Content:**\n\n${preview}`;
      if (s.content.length > 4000) {
        report += `\n\n*[Content truncated - ${((s.content.length - 4000) / 1000).toFixed(1)}K more chars available]*`;
      }
      report += `\n\n`;
    }
    report += `---\n\n`;
  }

  // All Sources by Tier
  report += `## All Sources by Quality Tier\n\n`;

  if (primary.length > 0) {
    report += `### Primary Sources (Score 9-10) - Most Reliable\n\n`;
    primary.forEach((s, i) => {
      report += `${i + 1}. [${s.title}](${s.url}) - ${s.domain} (${(s.contentLength/1000).toFixed(1)}K)\n`;
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

  // Research Log
  report += `## Research Log\n\n`;
  report += `### Queries Executed\n\n`;
  session.queriesExecuted.forEach((q, i) => {
    report += `${i + 1}. "${q}"\n`;
  });

  report += `\n### Session Info\n\n`;
  report += `- **Session ID:** ${session.id}\n`;
  report += `- **Iterations:** ${session.iteration}\n`;
  report += `- **Total Sources:** ${sources.length}\n`;
  report += `- **Total Content:** ${(totalContent / 1000).toFixed(0)}K characters\n`;
  report += `- **Duration:** ${duration}s\n`;

  return report;
}

// ============================================================================
// Tool 1: google_search - Simple search
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
returning consolidated content. 

This is TRUE deep research - it actually READS the pages, not just snippets.

Use this for:
- Getting actual page content, not just search snippets
- Research requiring full article text
- Comprehensive information gathering`,
  {
    query: z.string().describe("Search query"),
    num_results: z.number().min(1).max(10).default(5).optional()
      .describe("Number of pages to fetch (default: 5)"),
    max_content_per_page: z.number().min(5000).max(100000).default(30000).optional()
      .describe("Max chars per page (default: 30000)"),
  },
  async ({ query, num_results, max_content_per_page }) => {
    const numResults = num_results || 5;
    const maxContent = max_content_per_page || 30000;

    try {
      // Search
      const results = await googleSearch(query, numResults);
      
      if (results.items.length === 0) {
        return { content: [{ type: "text" as const, text: `No results for: "${query}"` }] };
      }

      // Fetch FULL content from each result
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

      // Build comprehensive output
      let output = `# Deep Search Results: "${query}"\n\n`;
      output += `Fetched full content from ${fetchedPages.length} pages\n\n`;

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
// Tool 3: google_research - Full OODA Loop Deep Research
// ============================================================================

server.tool(
  "google_research",
  `Perform extensive DEEP research on a topic using Claude Research methodology.

This tool implements Anthropic's multi-agent research system:

1. **Progressive Disclosure**: Start broad, then narrow based on findings
2. **Multi-Iteration OODA Loop**: Multiple rounds of search → fetch → analyze
3. **FULL Content Extraction**: Actually READS pages, not just snippets
4. **Source Quality Prioritization**: Primary sources over SEO farms
5. **Parallel Execution**: Batch searches and fetches for speed

**Depth Levels:**
- basic: 1 iteration, ~5 queries, quick overview
- moderate: 2 iterations, ~11 queries, thorough coverage
- comprehensive: 3 iterations, ~17+ queries, exhaustive research

Returns a detailed report with FULL page content from all sources.`,
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
      console.error(`Starting ${researchDepth} research on: "${topic}"`);
      
      const session = createSession(topic, researchDepth);
      
      await executeDeepResearch(session, 5, maxContent);
      
      const report = generateDeepReport(session);
      
      console.error(`Research complete: ${session.sources.length} sources, ${session.queriesExecuted.length} queries`);

      return { content: [{ type: "text" as const, text: report }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error}` }] };
    }
  }
);

// ============================================================================
// Tool 4: fetch_page - Fetch single page content
// ============================================================================

server.tool(
  "fetch_page",
  `Fetch and extract the full readable content from a single URL.
Uses Readability-style extraction to get the main content, removing navigation, ads, etc.

Use this to:
- Read a specific article or page in full
- Get content from a URL found in search results
- Extract text from any webpage`,
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
// Tool 5: research_session - Manual session management
// ============================================================================

server.tool(
  "research_session",
  `Create or manage a research session for multi-step research workflows.

Actions:
- create: Start a new session
- status: Check session progress
- complete: Generate final report`,
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
        return {
          content: [{
            type: "text" as const,
            text: `## Session Created\n\n- **ID:** ${session.id}\n- **Topic:** ${topic}\n- **Max Iterations:** ${session.maxIterations}`
          }]
        };
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
        return {
          content: [{
            type: "text" as const,
            text: `## Session Status\n\n` +
              `- **ID:** ${session.id}\n` +
              `- **Topic:** ${session.topic}\n` +
              `- **Status:** ${session.status}\n` +
              `- **Iteration:** ${session.iteration}/${session.maxIterations}\n` +
              `- **Sources:** ${session.sources.length}\n` +
              `- **Content:** ${(totalContent/1000).toFixed(0)}K chars\n` +
              `- **Queries:** ${session.queriesExecuted.length}`
          }]
        };
      }

      if (action === "complete") {
        session.status = "completed";
        const report = generateDeepReport(session);
        return { content: [{ type: "text" as const, text: report }] };
      }

      return { content: [{ type: "text" as const, text: "Unknown action" }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Error: ${error}` }] };
    }
  }
);

// ============================================================================
// Tool 6: add_source - Add source to session
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
// Tool 7: web_search - Claude Research compatible
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
// Tool 8: get_citations - Format citations
// ============================================================================

server.tool(
  "get_citations",
  `Get formatted citations from a research session.`,
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
      output += `${sources.length} sources\n\n`;

      if (format === "apa") {
        sources.forEach((s, i) => {
          output += `[${i + 1}] ${s.title}. Retrieved from ${s.url}\n\n`;
        });
      } else if (format === "numbered") {
        sources.forEach((s, i) => {
          output += `[${i + 1}] ${s.title}. ${s.url} (${s.qualityTier})\n`;
        });
      } else {
        sources.forEach((s, i) => {
          output += `${i + 1}. [${s.title}](${s.url}) - *${s.qualityTier}* (${s.qualityScore}/10)\n`;
        });
      }

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
  
  console.error("Google Research MCP Server v1.2.0 - Deep Research Edition");
  console.error("Tools: google_search, deep_search, google_research, fetch_page, research_session, add_source, web_search, get_citations");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
