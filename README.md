# Google Research MCP Server - Deep Research Edition

An MCP server that performs **TRUE deep research** by actually **fetching and reading full page content**, not just search snippets. Implements Claude Research methodology from Anthropic's multi-agent architecture.

[![npm version](https://badge.fury.io/js/google-research-mcp.svg)](https://www.npmjs.com/package/google-research-mcp)

## What Makes This Different

Most search tools only return **snippets** (2-3 sentences). This tool:

1. **Fetches FULL page content** - Actually reads the entire article/page
2. **Extracts readable text** - Uses Readability-style algorithm to get main content
3. **Multi-iteration research** - Progressive disclosure: broad → narrow
4. **Prioritizes primary sources** - .gov, .edu, research papers over SEO farms

## Tools

| Tool | Description |
|------|-------------|
| `deep_search` | Search + fetch FULL content from all results |
| `google_research` | Multi-iteration deep research with OODA loop |
| `fetch_page` | Fetch full content from a single URL |
| `google_search` | Simple search (snippets only) |
| `web_search` | Search with quality scoring |
| `research_session` | Manual session management |
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

### deep_search - Get Full Page Content

```
"Deep search for transformer architecture in neural networks"
```

Returns **full article content** from each result, not just snippets.

**Output includes:**
- Title, URL, domain
- Quality score (primary/authoritative/quality/general/low)
- **FULL extracted content** (up to 30K chars per page)

### google_research - Multi-Iteration Deep Research

```
"Research quantum computing applications with comprehensive depth"
```

**Depth levels:**
- `basic`: 1 iteration, ~5 queries
- `moderate`: 2 iterations, ~11 queries  
- `comprehensive`: 3 iterations, ~17+ queries

**Output includes:**
- Executive summary with source breakdown
- Detailed findings with **FULL content** from each source
- All sources organized by quality tier
- Complete research log

### fetch_page - Read Single Page

```
fetch_page({ url: "https://arxiv.org/abs/..." })
```

Fetches and extracts readable content from any URL.

## Source Quality Scoring

Based on Anthropic's source quality heuristics:

| Score | Tier | Examples |
|-------|------|----------|
| 10 | Primary | .gov, .edu, arxiv, nature.com, PubMed, official docs |
| 8-9 | Authoritative | Wikipedia, Reuters, BBC, NYT, WSJ |
| 7 | Quality | Stack Overflow, TechCrunch, Wired |
| 5-6 | General | Medium, Dev.to, Substack |
| 1-4 | Low | Pinterest, Facebook, Twitter (deprioritized) |

## Architecture

```
User Query
    ↓
┌─────────────────────────────────────────┐
│         Google Research MCP v1.2        │
│                                         │
│  ┌─────────────────────────────────┐   │
│  │     Progressive Query Engine     │   │
│  │  Iteration 1: Broad queries      │   │
│  │  Iteration 2: Narrower focus     │   │
│  │  Iteration 3: Deep dive          │   │
│  └─────────────────────────────────┘   │
│                  ↓                      │
│  ┌─────────────────────────────────┐   │
│  │      Google Custom Search        │   │
│  │      (Parallel batches)          │   │
│  └─────────────────────────────────┘   │
│                  ↓                      │
│  ┌─────────────────────────────────┐   │
│  │    DEEP Content Fetcher          │   │
│  │    - Fetches FULL pages          │   │
│  │    - Readability extraction      │   │
│  │    - Up to 50K chars/page        │   │
│  └─────────────────────────────────┘   │
│                  ↓                      │
│  ┌─────────────────────────────────┐   │
│  │    Source Quality Assessor       │   │
│  │    Primary > Auth > Quality      │   │
│  └─────────────────────────────────┘   │
│                  ↓                      │
│  ┌─────────────────────────────────┐   │
│  │    Report Generator              │   │
│  │    - Full content included       │   │
│  │    - Citations by quality tier   │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
    ↓
Comprehensive Report with FULL Content
```

## Changelog

### v1.2.0 - Deep Research Edition
- **NEW: Full page content fetching** - Actually reads pages, not just snippets
- **NEW: `deep_search` tool** - Search + fetch full content in one call
- **NEW: `fetch_page` tool** - Fetch any URL's full content
- Improved content extraction with Readability-style algorithm
- Better source quality patterns (added PubMed, research sites)
- Reports now include full content (up to 4K chars preview per source)
- Increased default content limits (50K chars per page)

### v1.1.0
- OODA Loop implementation
- Session management
- Two-level parallelization

### v1.0.0
- Initial release

## License

MIT
