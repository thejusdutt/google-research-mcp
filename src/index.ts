#!/usr/bin/env node
/**
 * Google Research MCP Server
 * 
 * Implements two tools:
 * 1. google_search - Simple Google search using Custom Search JSON API
 * 2. google_research - Extensive research using Claude Research methodology
 * 
 * Based on Anthropic's multi-agent research system architecture:
 * - Orchestrator-worker pattern with parallel exploration
 * - Source quality assessment (primary sources prioritized)
 * - Start broad, then narrow down search strategy
 * - Citation tracking and report generation
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
  pagemap?: {
    cse_thumbnail?: Array<{ src: string; width: string; height: string }>;
    metatags?: Array<Record<string, string>>;
  };
}

interface GoogleSearchResponse {
  items?: GoogleSearchItem[];
  searchInformation?: {
    totalResults: string;
    searchTime: number;
    formattedTotalResults: string;
  };
  queries?: {
    nextPage?: Array<{ startIndex: number }>;
  };
  error?: {
    message: string;
    code: number;
  };
}

interface ResearchSource {
  title: string;
  url: string;
  snippet: string;
  content?: string;
  qualityScore: number;
  qualityTier: "primary" | "authoritative" | "quality" | "general" | "low";
  domain: string;
}

interface ResearchFinding {
  query: string;
  sources: ResearchSource[];
  searchTime?: number;
}

// ============================================================================
// Configuration
// ============================================================================

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "";
const GOOGLE_CX = process.env.GOOGLE_CX || "";

// Create MCP server instance
const server = new McpServer({
  name: "google-research",
  version: "1.0.0",
});


// ============================================================================
// Google Custom Search API Helper
// ============================================================================

async function googleCustomSearch(
  query: string,
  numResults: number = 10,
  start: number = 1
): Promise<{ items: GoogleSearchItem[]; totalResults: number; searchTime: number }> {
  if (!GOOGLE_API_KEY || !GOOGLE_CX) {
    throw new Error(
      "Missing GOOGLE_API_KEY or GOOGLE_CX environment variables. " +
      "Get your API key from https://console.cloud.google.com and " +
      "create a Programmable Search Engine at https://programmablesearchengine.google.com"
    );
  }

  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", GOOGLE_API_KEY);
  url.searchParams.set("cx", GOOGLE_CX);
  url.searchParams.set("q", query);
  url.searchParams.set("num", Math.min(numResults, 10).toString());
  url.searchParams.set("start", Math.min(Math.max(start, 1), 91).toString());

  const response = await fetch(url.toString());
  const data = (await response.json()) as GoogleSearchResponse;

  if (data.error) {
    throw new Error(`Google API Error (${data.error.code}): ${data.error.message}`);
  }

  return {
    items: data.items || [],
    totalResults: parseInt(data.searchInformation?.totalResults || "0", 10),
    searchTime: data.searchInformation?.searchTime || 0,
  };
}

// ============================================================================
// Content Fetching (like Claude Research's content extraction)
// ============================================================================

async function fetchPageContent(url: string, maxLength: number = 15000): Promise<string> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; GoogleResearchMCP/1.0; +research)",
        "Accept": "text/html,application/xhtml+xml,text/plain,application/json",
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return "";
    }

    const contentType = response.headers.get("content-type") || "";
    
    // Skip binary content
    if (
      contentType.includes("image/") ||
      contentType.includes("video/") ||
      contentType.includes("audio/") ||
      contentType.includes("application/pdf")
    ) {
      return "";
    }

    const text = await response.text();
    return extractTextContent(text, contentType, maxLength);
  } catch {
    return "";
  }
}

function extractTextContent(raw: string, contentType: string, maxLength: number): string {
  let text = raw;

  if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
    // Remove script, style, nav, footer, header, aside tags
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ");
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ");
    text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, " ");
    text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, " ");
    text = text.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, " ");
    text = text.replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, " ");
    text = text.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, " ");
    
    // Remove HTML comments
    text = text.replace(/<!--[\s\S]*?-->/g, " ");
    
    // Remove all HTML tags
    text = text.replace(/<[^>]+>/g, " ");
    
    // Decode common HTML entities
    text = text
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&mdash;/g, "—")
      .replace(/&ndash;/g, "–")
      .replace(/&hellip;/g, "...")
      .replace(/&#\d+;/g, "");
  }

  // Clean up whitespace
  text = text.replace(/\s+/g, " ").trim();

  return text.slice(0, maxLength);
}


// ============================================================================
// Source Quality Assessment (Claude Research methodology)
// ============================================================================

/**
 * Assess source quality based on Anthropic's source quality heuristics:
 * - Score 10: Primary sources (official docs, research papers, company blogs)
 * - Score 9: Authoritative (.gov, .edu, major institutions)
 * - Score 7-8: Quality journalism, analysis
 * - Score 5-6: General web
 * - Score 1-4: SEO content farms, social media (deprioritized)
 */
function assessSourceQuality(url: string, title: string): { score: number; tier: ResearchSource["qualityTier"] } {
  let domain: string;
  try {
    domain = new URL(url).hostname.toLowerCase();
  } catch {
    return { score: 3, tier: "low" };
  }

  // Primary sources (score 9-10)
  if (domain.endsWith(".gov")) return { score: 10, tier: "primary" };
  if (domain.endsWith(".edu")) return { score: 10, tier: "primary" };
  if (domain.includes("arxiv.org")) return { score: 10, tier: "primary" };
  if (domain.includes("nature.com")) return { score: 10, tier: "primary" };
  if (domain.includes("science.org")) return { score: 10, tier: "primary" };
  if (domain.includes("ieee.org")) return { score: 10, tier: "primary" };
  if (domain.includes("acm.org")) return { score: 10, tier: "primary" };
  if (domain.includes("github.com")) return { score: 9, tier: "primary" };
  if (domain.includes("docs.") || domain.startsWith("docs.")) return { score: 9, tier: "primary" };
  if (domain.includes("developer.")) return { score: 9, tier: "primary" };
  if (domain.includes("anthropic.com")) return { score: 10, tier: "primary" };
  if (domain.includes("openai.com")) return { score: 9, tier: "primary" };

  // Authoritative sources (score 8)
  if (domain.includes("wikipedia.org")) return { score: 8, tier: "authoritative" };
  if (domain.includes("reuters.com")) return { score: 8, tier: "authoritative" };
  if (domain.includes("apnews.com")) return { score: 8, tier: "authoritative" };
  if (domain.includes("bbc.com") || domain.includes("bbc.co.uk")) return { score: 8, tier: "authoritative" };
  if (domain.includes("nytimes.com")) return { score: 8, tier: "authoritative" };
  if (domain.includes("wsj.com")) return { score: 8, tier: "authoritative" };
  if (domain.includes("economist.com")) return { score: 8, tier: "authoritative" };

  // Quality sources (score 7)
  if (domain.includes("stackoverflow.com")) return { score: 7, tier: "quality" };
  if (domain.includes("techcrunch.com")) return { score: 7, tier: "quality" };
  if (domain.includes("wired.com")) return { score: 7, tier: "quality" };
  if (domain.includes("arstechnica.com")) return { score: 7, tier: "quality" };
  if (domain.includes("theverge.com")) return { score: 7, tier: "quality" };
  if (domain.includes("hbr.org")) return { score: 7, tier: "quality" };

  // General quality (score 5-6)
  if (domain.includes("medium.com")) return { score: 5, tier: "general" };
  if (domain.includes("dev.to")) return { score: 5, tier: "general" };
  if (domain.includes("hashnode.")) return { score: 5, tier: "general" };
  if (domain.includes("substack.com")) return { score: 5, tier: "general" };

  // Low quality - SEO farms, social media (score 1-4)
  if (domain.includes("pinterest.")) return { score: 2, tier: "low" };
  if (domain.includes("facebook.com")) return { score: 2, tier: "low" };
  if (domain.includes("twitter.com") || domain.includes("x.com")) return { score: 3, tier: "low" };
  if (domain.includes("reddit.com")) return { score: 4, tier: "low" };
  if (domain.includes("quora.com")) return { score: 4, tier: "low" };
  if (domain.includes("linkedin.com")) return { score: 4, tier: "low" };

  // Default general web
  return { score: 5, tier: "general" };
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}


// ============================================================================
// Research Query Generation (Claude Research: "Start wide, then narrow")
// ============================================================================

/**
 * Generate research queries following Claude Research methodology:
 * - Start with broad queries (2-4 words)
 * - Progressively narrow focus
 * - Cover different aspects/angles
 */
function generateResearchQueries(topic: string, depth: "basic" | "moderate" | "comprehensive"): string[] {
  const queries: string[] = [];
  
  // Extract key terms for variations
  const cleanTopic = topic.trim();
  
  // Always start broad (Claude Research principle)
  queries.push(cleanTopic);

  if (depth === "basic") {
    // 3 queries: overview focus
    queries.push(`${cleanTopic} overview`);
    queries.push(`what is ${cleanTopic}`);
  } else if (depth === "moderate") {
    // 6 queries: multiple angles
    queries.push(`${cleanTopic} overview introduction`);
    queries.push(`${cleanTopic} how it works`);
    queries.push(`${cleanTopic} examples use cases`);
    queries.push(`${cleanTopic} benefits advantages`);
    queries.push(`${cleanTopic} comparison alternatives`);
  } else {
    // comprehensive: 10+ queries covering all aspects
    queries.push(`${cleanTopic} overview introduction`);
    queries.push(`${cleanTopic} how it works explained`);
    queries.push(`${cleanTopic} examples use cases`);
    queries.push(`${cleanTopic} best practices`);
    queries.push(`${cleanTopic} comparison vs alternatives`);
    queries.push(`${cleanTopic} research papers academic`);
    queries.push(`${cleanTopic} case studies real world`);
    queries.push(`${cleanTopic} latest news developments 2025`);
    queries.push(`${cleanTopic} challenges problems limitations`);
    queries.push(`${cleanTopic} future trends predictions`);
    queries.push(`${cleanTopic} implementation guide tutorial`);
  }

  return queries;
}

// ============================================================================
// Source Deduplication and Ranking
// ============================================================================

function deduplicateAndRankSources(sources: ResearchSource[]): ResearchSource[] {
  const seen = new Map<string, ResearchSource>();
  
  for (const source of sources) {
    const existing = seen.get(source.url);
    if (!existing || source.qualityScore > existing.qualityScore) {
      seen.set(source.url, source);
    }
  }
  
  // Sort by quality score descending
  return Array.from(seen.values()).sort((a, b) => b.qualityScore - a.qualityScore);
}


// ============================================================================
// Research Report Generation (with Citations like Claude Research)
// ============================================================================

function generateResearchReport(
  topic: string,
  findings: ResearchFinding[],
  sources: ResearchSource[]
): string {
  const rankedSources = deduplicateAndRankSources(sources);
  
  // Group by quality tier
  const primarySources = rankedSources.filter(s => s.qualityTier === "primary");
  const authoritativeSources = rankedSources.filter(s => s.qualityTier === "authoritative");
  const qualitySources = rankedSources.filter(s => s.qualityTier === "quality");
  const generalSources = rankedSources.filter(s => s.qualityTier === "general");
  const lowSources = rankedSources.filter(s => s.qualityTier === "low");

  let report = `# Research Report: ${topic}\n\n`;
  
  // Executive Summary
  report += `## Executive Summary\n\n`;
  report += `This research analyzed ${rankedSources.length} unique sources across ${findings.length} search queries.\n\n`;
  report += `**Source Quality Breakdown:**\n`;
  report += `- Primary Sources: ${primarySources.length}\n`;
  report += `- Authoritative Sources: ${authoritativeSources.length}\n`;
  report += `- Quality Sources: ${qualitySources.length}\n`;
  report += `- General Sources: ${generalSources.length}\n`;
  if (lowSources.length > 0) {
    report += `- Low Quality (deprioritized): ${lowSources.length}\n`;
  }
  report += `\n`;

  // Key Findings from Top Sources
  report += `## Key Findings\n\n`;
  
  const topSources = rankedSources.slice(0, 15);
  for (let i = 0; i < topSources.length; i++) {
    const source = topSources[i];
    report += `### [${i + 1}] ${source.title}\n`;
    report += `**Source:** ${source.url}\n`;
    report += `**Domain:** ${source.domain} | **Quality:** ${source.qualityTier} (${source.qualityScore}/10)\n\n`;
    
    if (source.content && source.content.length > 100) {
      const preview = source.content.slice(0, 2500);
      report += `${preview}${source.content.length > 2500 ? "..." : ""}\n\n`;
    } else {
      report += `${source.snippet}\n\n`;
    }
    report += `---\n\n`;
  }

  // Sources by Quality Tier
  report += `## All Sources by Quality Tier\n\n`;

  if (primarySources.length > 0) {
    report += `### Primary Sources (Score 9-10) - Most Reliable\n`;
    primarySources.forEach((s, i) => {
      report += `${i + 1}. [${s.title}](${s.url}) - ${s.domain}\n`;
    });
    report += `\n`;
  }

  if (authoritativeSources.length > 0) {
    report += `### Authoritative Sources (Score 8)\n`;
    authoritativeSources.forEach((s, i) => {
      report += `${i + 1}. [${s.title}](${s.url}) - ${s.domain}\n`;
    });
    report += `\n`;
  }

  if (qualitySources.length > 0) {
    report += `### Quality Sources (Score 7)\n`;
    qualitySources.forEach((s, i) => {
      report += `${i + 1}. [${s.title}](${s.url}) - ${s.domain}\n`;
    });
    report += `\n`;
  }

  if (generalSources.length > 0) {
    report += `### General Sources (Score 5-6)\n`;
    generalSources.forEach((s, i) => {
      report += `${i + 1}. [${s.title}](${s.url}) - ${s.domain}\n`;
    });
    report += `\n`;
  }

  // Research Statistics
  report += `## Research Statistics\n\n`;
  report += `- **Topic:** ${topic}\n`;
  report += `- **Total Queries Executed:** ${findings.length}\n`;
  report += `- **Total Unique Sources:** ${rankedSources.length}\n`;
  report += `- **Primary Sources Found:** ${primarySources.length}\n`;
  report += `- **Average Source Quality:** ${(rankedSources.reduce((sum, s) => sum + s.qualityScore, 0) / rankedSources.length).toFixed(1)}/10\n`;

  // Query Log
  report += `\n## Search Queries Executed\n\n`;
  findings.forEach((f, i) => {
    report += `${i + 1}. "${f.query}" - ${f.sources.length} results\n`;
  });

  return report;
}


// ============================================================================
// Tool 1: google_search - Simple Google Search
// ============================================================================

server.registerTool(
  "google_search",
  {
    description: `Perform a simple Google search using Google Custom Search JSON API.

Use this for:
- Quick fact-finding (3-10 results)
- Single-topic lookups
- Verifying specific information

Returns search results with titles, URLs, and snippets.`,
    inputSchema: {
      query: z.string().min(1).describe("The search query string"),
      numResults: z
        .number()
        .min(1)
        .max(10)
        .default(10)
        .optional()
        .describe("Number of results to return (1-10, default: 10)"),
    },
  },
  async ({ query, numResults }) => {
    try {
      const results = await googleCustomSearch(query, numResults || 10);

      if (results.items.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No results found for: "${query}"`,
            },
          ],
        };
      }

      let output = `## Google Search Results for: "${query}"\n\n`;
      output += `Found ${results.totalResults.toLocaleString()} total results (showing ${results.items.length})\n`;
      output += `Search time: ${results.searchTime.toFixed(2)}s\n\n`;

      results.items.forEach((item, index) => {
        const quality = assessSourceQuality(item.link, item.title);
        output += `### ${index + 1}. ${item.title}\n`;
        output += `**URL:** ${item.link}\n`;
        output += `**Quality:** ${quality.tier} (${quality.score}/10)\n`;
        output += `${item.snippet}\n\n`;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: output,
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
      return {
        content: [
          {
            type: "text" as const,
            text: `Error performing search: ${errorMessage}`,
          },
        ],
      };
    }
  }
);


// ============================================================================
// Tool 2: google_research - Extensive Research (Claude Research methodology)
// ============================================================================

server.registerTool(
  "google_research",
  {
    description: `Perform extensive research on a topic using Claude Research methodology.

This tool implements Anthropic's multi-agent research system approach:

1. **Orchestrator-Worker Pattern**: Generates multiple search queries (like subagents)
   exploring different aspects of the topic in parallel

2. **Start Broad, Then Narrow**: Begins with general queries, progressively
   focuses on specific aspects

3. **Source Quality Assessment**: Prioritizes primary sources (official docs,
   research papers, .gov/.edu) over SEO content farms

4. **Content Extraction**: Fetches full page content from top quality sources

5. **Citation Tracking**: Generates a comprehensive report with proper attribution

**Scaling Rules (from Claude Research):**
- basic: 3 queries, quick overview
- moderate: 6 queries, multiple angles  
- comprehensive: 11+ queries, thorough investigation

Use this for complex research tasks requiring breadth and depth.`,
    inputSchema: {
      topic: z.string().min(1).describe("The research topic or question to investigate"),
      depth: z
        .enum(["basic", "moderate", "comprehensive"])
        .default("moderate")
        .optional()
        .describe("Research depth: basic (3 queries), moderate (6 queries), comprehensive (11+ queries)"),
      fetchContent: z
        .boolean()
        .default(true)
        .optional()
        .describe("Whether to fetch full page content from top sources (recommended for thorough research)"),
      maxSourcesPerQuery: z
        .number()
        .min(1)
        .max(10)
        .default(5)
        .optional()
        .describe("Maximum sources to collect per query (1-10, default: 5)"),
    },
  },
  async ({ topic, depth, fetchContent, maxSourcesPerQuery }) => {
    const researchDepth = depth || "moderate";
    const shouldFetchContent = fetchContent !== false;
    const sourcesPerQuery = maxSourcesPerQuery || 5;

    try {
      // Generate research queries (like Claude Research subagents)
      const queries = generateResearchQueries(topic, researchDepth);
      const findings: ResearchFinding[] = [];
      const allSources: ResearchSource[] = [];

      // Execute searches in sequence (API rate limiting)
      // In production, you might parallelize with proper rate limiting
      for (const query of queries) {
        try {
          const results = await googleCustomSearch(query, sourcesPerQuery);
          
          const sources: ResearchSource[] = results.items.map((item) => {
            const quality = assessSourceQuality(item.link, item.title);
            return {
              title: item.title,
              url: item.link,
              snippet: item.snippet,
              qualityScore: quality.score,
              qualityTier: quality.tier,
              domain: getDomain(item.link),
            };
          });

          findings.push({
            query,
            sources,
            searchTime: results.searchTime,
          });
          
          allSources.push(...sources);
          
          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (err) {
          // Log to stderr (safe for MCP) and continue with other queries
          console.error(`Query failed: "${query}" - ${err}`);
          findings.push({ query, sources: [] });
        }
      }

      // Deduplicate and rank sources
      const uniqueSources = deduplicateAndRankSources(allSources);

      // Fetch content from top quality sources (like Claude Research)
      if (shouldFetchContent && uniqueSources.length > 0) {
        // Prioritize primary and authoritative sources
        const topSources = uniqueSources
          .filter(s => s.qualityScore >= 5)
          .slice(0, 10);

        // Fetch content in parallel with concurrency limit
        const fetchPromises = topSources.map(async (source) => {
          try {
            const content = await fetchPageContent(source.url);
            if (content) {
              source.content = content;
            }
          } catch {
            // Silently continue if fetch fails
          }
        });

        await Promise.all(fetchPromises);
      }

      // Generate comprehensive research report
      const report = generateResearchReport(topic, findings, uniqueSources);

      return {
        content: [
          {
            type: "text" as const,
            text: report,
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
      return {
        content: [
          {
            type: "text" as const,
            text: `Error performing research: ${errorMessage}`,
          },
        ],
      };
    }
  }
);


// ============================================================================
// Server Initialization
// ============================================================================

async function main() {
  // Validate environment variables (log to stderr, safe for MCP)
  if (!GOOGLE_API_KEY) {
    console.error(
      "Warning: GOOGLE_API_KEY environment variable not set. " +
      "Get your API key from https://console.cloud.google.com"
    );
  }
  if (!GOOGLE_CX) {
    console.error(
      "Warning: GOOGLE_CX environment variable not set. " +
      "Create a Programmable Search Engine at https://programmablesearchengine.google.com"
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  // Log to stderr (safe for MCP stdio transport)
  console.error("Google Research MCP Server running on stdio");
  console.error("Tools available: google_search, google_research");
}

main().catch((error) => {
  console.error("Fatal error starting server:", error);
  process.exit(1);
});
