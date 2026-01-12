# Google Research MCP Server

An MCP (Model Context Protocol) server that provides Google search capabilities using Google's Custom Search JSON API, implementing **Claude Research methodology** for extensive research tasks.

[![npm version](https://badge.fury.io/js/google-research-mcp.svg)](https://www.npmjs.com/package/google-research-mcp)

## Features

### Two Tools

| Tool | Description | Use Case |
|------|-------------|----------|
| `google_search` | Simple Google search | Quick fact-finding, single-topic lookups |
| `google_research` | Extensive research with Claude Research methodology | Complex research requiring breadth and depth |

### Claude Research Methodology

Based on [Anthropic's multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system):

- **Orchestrator-Worker Pattern**: Generates multiple search queries (like subagents) exploring different aspects
- **"Start Broad, Then Narrow"**: Begins with general queries, progressively focuses on specifics
- **Source Quality Assessment**: Prioritizes primary sources over SEO content farms
- **Content Extraction**: Fetches full page content from top quality sources
- **Citation Tracking**: Generates comprehensive reports with proper attribution

### Source Quality Scoring

| Score | Tier | Examples |
|-------|------|----------|
| 10 | Primary | .gov, .edu, arxiv.org, official docs |
| 9 | Primary | GitHub, Mayo Clinic, Cleveland Clinic |
| 8 | Authoritative | Wikipedia, Reuters, BBC |
| 7 | Quality | Stack Overflow, TechCrunch, Wired |
| 5-6 | General | Medium, Dev.to, general web |
| 1-4 | Low | Pinterest, Facebook, Twitter (deprioritized) |

## Installation

### Via npx (recommended)

No installation needed - just configure and run:

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

### Global Installation

```bash
npm install -g google-research-mcp
```

### Local Installation

```bash
npm install google-research-mcp
```

## Prerequisites

You need two things from Google:

### 1. Google API Key

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project or select existing
3. Enable **"Custom Search API"** from the API Library
4. Go to **Credentials** → **Create Credentials** → **API Key**
5. Copy the API key

### 2. Programmable Search Engine ID (CX)

1. Go to [Programmable Search Engine](https://programmablesearchengine.google.com)
2. Click **"Add"** to create a new search engine
3. For "Sites to search", select **"Search the entire web"**
4. Give it a name and click **"Create"**
5. Copy the **Search Engine ID** (looks like `a1b2c3d4e5f6g7h8i`)

### Pricing

- **Free**: 100 queries per day
- **Paid**: $5 per 1,000 queries (up to 10k/day)

## Configuration

### For Kiro

Add to `.kiro/settings/mcp.json`:

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

### For Claude Desktop

Add to `claude_desktop_config.json`:

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

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_API_KEY` | Yes | Your Google Cloud API key |
| `GOOGLE_CX` | Yes | Your Programmable Search Engine ID |

## Usage

### google_search

Simple search for quick lookups:

```
"Search for TypeScript MCP server tutorial"
```

**Parameters:**
- `query` (required): Search query string
- `numResults` (optional): 1-10, default 10

**Returns:** Search results with titles, URLs, snippets, and quality scores

### google_research

Extensive research using Claude Research methodology:

```
"Research multi-agent AI systems with comprehensive depth"
```

**Parameters:**
- `topic` (required): Research topic or question
- `depth` (optional): `basic` | `moderate` | `comprehensive`
  - `basic`: 3 queries, quick overview
  - `moderate`: 6 queries, multiple angles (default)
  - `comprehensive`: 11+ queries, thorough investigation
- `fetchContent` (optional): Whether to fetch full page content (default: true)
- `maxSourcesPerQuery` (optional): 1-10, default 5

**Returns:** Comprehensive research report with:
- Executive summary
- Source quality breakdown
- Key findings from top sources (with full content)
- All sources organized by quality tier
- Research statistics

## Example Output

### google_search

```
## Google Search Results for: "Bangalore weather"

Found 246,000,000 total results (showing 5)
Search time: 0.42s

### 1. Bengaluru Weather Forecast | AccuWeather
**URL:** https://www.accuweather.com/en/in/bengaluru/...
**Quality:** general (5/10)
Current conditions and 3-day forecast...
```

### google_research

```
# Research Report: Thyroid Health Management

## Executive Summary
Analyzed 22 unique sources across 6 queries.

**Source Quality Breakdown:**
- Primary Sources: 9
- Authoritative Sources: 0
- Quality Sources: 2
- General Sources: 11

## Key Findings

### [1] Hypothyroidism - StatPearls - NCBI Bookshelf
Source: https://www.ncbi.nlm.nih.gov/books/NBK519536/
Quality: PRIMARY (10/10)

[Full content from source...]

---

## All Sources by Quality Tier

### Primary Sources (Score 9-10)
1. [Hypothyroidism - NCBI](https://www.ncbi.nlm.nih.gov/...)
2. [Thyroid Disease - Cleveland Clinic](https://my.clevelandclinic.org/...)
...
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                 MCP Client (Kiro/Claude)                │
└─────────────────────────┬───────────────────────────────┘
                          │ stdio
┌─────────────────────────▼───────────────────────────────┐
│              Google Research MCP Server                  │
│  ┌─────────────────┐  ┌─────────────────────────────┐   │
│  │  google_search  │  │      google_research        │   │
│  │  (simple)       │  │  (Claude Research method)   │   │
│  └────────┬────────┘  └──────────────┬──────────────┘   │
│           │                          │                   │
│           │    ┌─────────────────────┼──────────┐       │
│           │    │  Query Generation   │          │       │
│           │    │  (subagent-like)    │          │       │
│           │    └─────────────────────┘          │       │
│           │                                     │       │
│           ▼                                     ▼       │
│  ┌─────────────────────────────────────────────────┐   │
│  │         Google Custom Search JSON API            │   │
│  └─────────────────────────────────────────────────┘   │
│                          │                              │
│           ┌──────────────┼──────────────┐              │
│           ▼              ▼              ▼              │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐      │
│  │   Source    │ │   Content   │ │   Report    │      │
│  │   Quality   │ │   Fetcher   │ │  Generator  │      │
│  │  Assessor   │ │             │ │             │      │
│  └─────────────┘ └─────────────┘ └─────────────┘      │
└─────────────────────────────────────────────────────────┘
```

## Development

```bash
# Clone and install
git clone https://github.com/thejusdutt/google-research-mcp.git
cd google-research-mcp
npm install

# Build
npm run build

# Run locally
GOOGLE_API_KEY=your-key GOOGLE_CX=your-cx npm start
```

## Troubleshooting

### "Custom Search API has not been used in project"
Enable the Custom Search API in your Google Cloud Console.

### "API_KEY_SERVICE_BLOCKED"
Your API key has restrictions. Go to Google Cloud Console → Credentials → Edit your API key → Add "Custom Search API" to allowed APIs.

### "Missing GOOGLE_API_KEY or GOOGLE_CX"
Ensure both environment variables are set in your MCP configuration.

## License

MIT

## Credits

- Based on [Anthropic's Claude Research methodology](https://www.anthropic.com/engineering/multi-agent-research-system)
- Uses [Model Context Protocol](https://modelcontextprotocol.io/) by Anthropic
- Powered by [Google Custom Search JSON API](https://developers.google.com/custom-search/v1/overview)
