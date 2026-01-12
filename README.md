# Google Research MCP Server v2.0.0 - Multi-Agent Architecture

An MCP server that implements **Anthropic's Multi-Agent Research Architecture** with true subagent spawning, adaptive stopping, and citation processing.

[![npm version](https://badge.fury.io/js/google-research-mcp.svg)](https://www.npmjs.com/package/google-research-mcp)

## Architecture Overview

This implementation is **fully compliant** with Anthropic's multi-agent research system:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Multi-Agent Research System                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              LEAD RESEARCHER (Orchestrator)               │   │
│  │                                                           │   │
│  │  • think(plan approach) - Decompose into aspects          │   │
│  │  • create subagents - Spawn parallel workers              │   │
│  │  • think(synthesize) - Combine findings                   │   │
│  │  • evaluate coverage - "More research needed?"            │   │
│  │  • complete_task - Return final report                    │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│              ┌───────────────┼───────────────┐                  │
│              ▼               ▼               ▼                  │
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐      │
│  │  SUBAGENT 1    │ │  SUBAGENT 2    │ │  SUBAGENT N    │      │
│  │  (Aspect A)    │ │  (Aspect B)    │ │  (Aspect N)    │      │
│  │                │ │                │ │                │      │
│  │ • web_search   │ │ • web_search   │ │ • web_search   │      │
│  │ • think(eval)  │ │ • think(eval)  │ │ • think(eval)  │      │
│  │ • complete     │ │ • complete     │ │ • complete     │      │
│  └────────────────┘ └────────────────┘ └────────────────┘      │
│              │               │               │                  │
│              └───────────────┼───────────────┘                  │
│                              ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    CITATION AGENT                         │   │
│  │  • Process documents                                      │   │
│  │  • Identify citation locations                            │   │
│  │  • Insert inline citations [1], [2], etc.                │   │
│  │  • Generate references section                            │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    MEMORY MODULE                          │   │
│  │  • save plan                                              │   │
│  │  • retrieve context                                       │   │
│  │  • persist findings                                       │   │
│  │  • track gaps                                             │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Process Flow

Based on Anthropic's sequence diagram:

```
User                LeadResearcher        Subagent1         Subagent2         Memory          CitationAgent
 │                       │                    │                 │                │                  │
 │──send user query────▶│                    │                 │                │                  │
 │                       │                    │                 │                │                  │
 │                       │◀─────────────────────────────────────────────────────│                  │
 │                       │  think(plan approach)                                │                  │
 │                       │                    │                 │                │                  │
 │                       │──save plan────────────────────────────────────────▶│                  │
 │                       │                    │                 │                │                  │
 │                       │──retrieve context──────────────────────────────────▶│                  │
 │                       │                    │                 │                │                  │
 │                       │                    │                 │                │                  │
 │                       │══════════════════════════════════════════════════════│                  │
 │                       │                 ITERATIVE RESEARCH LOOP              │                  │
 │                       │══════════════════════════════════════════════════════│                  │
 │                       │                    │                 │                │                  │
 │                       │──create subagent──▶│                 │                │                  │
 │                       │──create subagent────────────────────▶│                │                  │
 │                       │                    │                 │                │                  │
 │                       │                    │──web_search────▶│                │                  │
 │                       │                    │◀───results──────│                │                  │
 │                       │                    │                 │                │                  │
 │                       │                    │  think(evaluate)│                │                  │
 │                       │                    │                 │                │                  │
 │                       │◀──complete_task────│                 │                │                  │
 │                       │                    │                 │                │                  │
 │                       │                    │                 │──web_search───▶│                  │
 │                       │                    │                 │◀──results──────│                  │
 │                       │                    │                 │                │                  │
 │                       │                    │                 │ think(evaluate)│                  │
 │                       │                    │                 │                │                  │
 │                       │◀─────────────────────complete_task───│                │                  │
 │                       │                    │                 │                │                  │
 │                       │  think(synthesize results)           │                │                  │
 │                       │                    │                 │                │                  │
 │                       │         ┌─────────────────────┐      │                │                  │
 │                       │         │ More research needed?│      │                │                  │
 │                       │         └─────────────────────┘      │                │                  │
 │                       │              │           │           │                │                  │
 │                       │         [Continue]   [Exit Loop]     │                │                  │
 │                       │              │           │           │                │                  │
 │                       │══════════════════════════════════════════════════════│                  │
 │                       │                    │                 │                │                  │
 │                       │──complete_task (research result)────────────────────▶│                  │
 │                       │                    │                 │                │                  │
 │                       │                    │                 │                │──────────────────▶│
 │                       │                    │                 │                │  Process docs +   │
 │                       │                    │                 │                │  insert citations │
 │                       │◀───────────────────────────────────────────────────────────────────────│
 │                       │                    │                 │                │  Report with      │
 │                       │                    │                 │                │  citations        │
 │                       │──persist results──────────────────────────────────▶│                  │
 │                       │                    │                 │                │                  │
 │◀──return research─────│                    │                 │                │                  │
 │   results with        │                    │                 │                │                  │
 │   citations           │                    │                 │                │                  │
```

## Key Features

### 1. True Subagent Spawning
Each aspect gets its own subagent that runs independently:
- Generates aspect-specific queries
- Executes web searches
- Fetches full page content
- Evaluates findings
- Reports back to Lead Researcher

### 2. Think/Evaluate Phases
Explicit reasoning phases between iterations:
- `think(plan approach)` - Decompose topic into aspects
- `think(evaluate)` - Each subagent evaluates its findings
- `think(synthesize)` - Lead Researcher combines all findings

### 3. Adaptive Stopping
Dynamic "More research needed?" decision:
- Coverage score calculation (0-100%)
- Configurable thresholds per depth level
- Gap identification and filling
- Exits early when coverage is sufficient

### 4. Aspect-Based Decomposition
Topics are broken into researchable aspects:
- Basic: 2 aspects (overview, mechanism)
- Moderate: 5 aspects (+use cases, benefits, challenges)
- Comprehensive: 11 aspects (+history, comparisons, implementation, future, research, case studies)

### 5. Memory Module
Persistent context across iterations:
- Research plan storage
- Findings per aspect
- Gap tracking
- Iteration history

### 6. Citation Agent
Dedicated citation processing:
- Assigns citation IDs by quality
- Inserts inline citations [1], [2]
- Generates references section
- Groups by quality tier

## Tools

| Tool | Description |
|------|-------------|
| `google_research` | **Full multi-agent research** with all components |
| `deep_search` | Search + fetch full content (single iteration) |
| `deep_search_news` | News-specific deep search |
| `fetch_page` | Fetch single page content |
| `google_search` | Simple search (snippets only) |
| `web_search` | Search with quality scoring |
| `research_session` | Manual session management |
| `run_subagent` | Manually spawn a subagent |
| `evaluate_coverage` | Check coverage and gaps |
| `add_source` | Add source to session |
| `get_citations` | Format citations |

## Installation

```json
{
  "mcpServers": {
    "google-research": {
      "command": "npx",
      "args": ["google-research-mcp"],
      "env": {
        "GOOGLE_API_KEY": "your-api-key",
        "GOOGLE_CX": "your-search-engine-id"
      }
    }
  }
}
```

## Prerequisites

### 1. Google API Key
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Enable **"Custom Search API"**
3. Create an API Key

### 2. Search Engine ID (CX)
1. Go to [Programmable Search Engine](https://programmablesearchengine.google.com)
2. Create engine with **"Search the entire web"**
3. Copy the Search Engine ID

## Usage Examples

### Full Multi-Agent Research

```
"Research quantum computing with comprehensive depth"
```

This triggers the full architecture:
1. Lead Researcher plans 11 aspects
2. Spawns 3-4 subagents per iteration
3. Each subagent researches in parallel
4. Evaluates coverage after each iteration
5. Continues until 90% coverage or max iterations
6. Citation Agent processes final report

### Manual Subagent Control

```javascript
// Create session
research_session({ action: "create", topic: "AI safety", depth: "moderate" })

// Spawn specific subagents
run_subagent({ sessionId: "rs_xxx", aspect: "AI alignment techniques" })
run_subagent({ sessionId: "rs_xxx", aspect: "AI safety research organizations" })

// Check coverage
evaluate_coverage({ sessionId: "rs_xxx" })

// Generate final report
research_session({ action: "complete", sessionId: "rs_xxx" })
```

## Depth Levels

| Depth | Iterations | Aspects | Coverage Threshold | Min Sources/Aspect |
|-------|------------|---------|-------------------|-------------------|
| basic | 2 | 2 | 60% | 2 |
| moderate | 3 | 5 | 75% | 3 |
| comprehensive | 4 | 11 | 90% | 5 |

## Source Quality Scoring

Based on Anthropic's source quality heuristics:

| Score | Tier | Examples |
|-------|------|----------|
| 10 | Primary | .gov, .edu, arxiv, nature.com, PubMed, official docs |
| 8-9 | Authoritative | Wikipedia, Reuters, BBC, NYT, WSJ |
| 7 | Quality | Stack Overflow, TechCrunch, Wired |
| 5-6 | General | Medium, Dev.to, Substack |
| 1-4 | Low | Pinterest, Facebook, Twitter (deprioritized) |

## Changelog

### v2.0.0 - Multi-Agent Architecture (Anthropic Compliant)
- **NEW: True subagent spawning** - Parallel workers for different aspects
- **NEW: Think/Evaluate phases** - Explicit reasoning between iterations
- **NEW: Adaptive stopping** - Dynamic "More research needed?" decision
- **NEW: Aspect-based decomposition** - Topics broken into researchable aspects
- **NEW: Memory module** - Persistent context across iterations
- **NEW: Citation Agent** - Dedicated citation processing with inline insertion
- **NEW: `run_subagent` tool** - Manual subagent control
- **NEW: `evaluate_coverage` tool** - Check coverage and gaps
- **NEW: `deep_search_news` tool** - News-specific deep search
- Improved report generation with subagent reports
- Full iteration history tracking

### v1.2.0 - Deep Research Edition
- Full page content fetching
- Readability-style extraction
- Source quality scoring

### v1.0.0
- Initial release

## License

MIT
