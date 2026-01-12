# Google Research MCP Server

An MCP server implementing **Claude Research methodology** based on Anthropic's paper: *"Claude Research: A Multi-Agent System for Autonomous Information Retrieval and Synthesis"*.

[![npm version](https://badge.fury.io/js/google-research-mcp.svg)](https://www.npmjs.com/package/google-research-mcp)

## Key Features from Claude Research Paper

### OODA Loop Implementation (Section 3.2)
Each research task uses iterative **Observe-Orient-Decide-Act** loops:
- **Observe**: Assess current knowledge gathered
- **Orient**: Identify knowledge gaps based on findings
- **Decide**: Select best queries to fill gaps
- **Act**: Execute searches in parallel batches

### Two-Level Parallelization (Section 4.1)
- **Agent-level**: Multiple query aspects explored simultaneously
- **Tool-level**: Batch execution of searches (3 concurrent)

### Progressive Narrowing Strategy (Section 3.3)
- Start with broad, short queries (1-6 words)
- Progressively narrow based on intermediate findings
- Dynamic query generation to fill knowledge gaps

### Source Quality Assessment (Section 5.2)
Prioritizes primary sources over SEO content farms:

| Score | Tier | Examples |
|-------|------|----------|
| 10 | Primary | .gov, .edu, arxiv.org, official docs, research papers |
| 9 | Primary | GitHub, NCBI, PubMed |
| 8 | Authoritative | Wikipedia, Reuters, BBC, NYT |
| 7 | Quality | Stack Overflow, TechCrunch, Wired |
| 5-6 | General | Medium, Dev.to |
| 1-4 | Low | Pinterest, Facebook, Twitter (deprioritized) |

## Tools

| Tool | Description |
|------|-------------|
| `google_search` | Simple search for quick lookups |
| `google_research` | Full OODA loop research with automatic gap filling |
| `web_search` | Claude Research compatible search with quality scoring |
| `research_session` | Create/manage research sessions (Memory Module) |
| `add_source` | Track sources for citation |
| `get_citations` | Get formatted citations |
| `generate_report` | Generate final research report |

## Installation

### Via npx (recommended)

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

## Prerequisites

### 1. Google API Key
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Enable **"Custom Search API"**
3. Create an API Key under Credentials

### 2. Programmable Search Engine ID (CX)
1. Go to [Programmable Search Engine](https://programmablesearchengine.google.com)
2. Create a search engine with **"Search the entire web"**
3. Copy the Search Engine ID

### Pricing
- **Free**: 100 queries/day
- **Paid**: $5 per 1,000 queries

## Usage Examples

### google_research (Full OODA Loop)

```
"Research multi-agent AI systems with comprehensive depth"
```

**Parameters:**
- `topic`: Research topic
- `depth`: `basic` (1 iter) | `moderate` (2 iter) | `comprehensive` (3 iter)
- `fetchContent`: Fetch full page content (default: true)
- `maxSourcesPerQuery`: 1-10 (default: 5)

**Output includes:**
- Executive summary with source quality breakdown
- Key findings from top sources (with content)
- All sources organized by quality tier
- Knowledge gaps identified
- Research statistics (queries, sources, tokens, duration)
- OODA iteration log

### research_session (Manual Control)

For fine-grained control over the research process:

```javascript
// 1. Create session
research_session({ action: "create", query: "quantum computing applications" })

// 2. Execute searches
web_search({ query: "quantum computing overview", sessionId: "rs_..." })
web_search({ query: "quantum computing use cases", sessionId: "rs_..." })

// 3. Add verified sources
add_source({ sessionId: "rs_...", url: "...", title: "..." })

// 4. Update with findings
research_session({ action: "update", sessionId: "rs_...", findings: [...], gaps: [...] })

// 5. Generate report
generate_report({ sessionId: "rs_..." })
```

## Architecture

Based on Claude Research paper architecture (Section 2):

```
┌─────────────────────────────────────────────────────────────┐
│                    MCP Client (Kiro/Claude)                  │
└─────────────────────────────┬───────────────────────────────┘
                              │ stdio
┌─────────────────────────────▼───────────────────────────────┐
│               Google Research MCP Server v1.1                │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                    OODA Loop Engine                     │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │ │
│  │  │ OBSERVE  │→│  ORIENT  │→│  DECIDE  │→│   ACT    │  │ │
│  │  │ Assess   │ │ Identify │ │ Select   │ │ Execute  │  │ │
│  │  │ knowledge│ │ gaps     │ │ queries  │ │ parallel │  │ │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘  │ │
│  └────────────────────────────────────────────────────────┘ │
│                              │                               │
│  ┌───────────────────────────▼────────────────────────────┐ │
│  │              Two-Level Parallelization                  │ │
│  │  Level 1: Agent-level (multiple aspects)               │ │
│  │  Level 2: Tool-level (batch of 3 concurrent searches)  │ │
│  └─────────────────────────────────────────────────────────┘ │
│                              │                               │
│  ┌───────────────────────────▼────────────────────────────┐ │
│  │                 Google Custom Search API                │ │
│  └─────────────────────────────────────────────────────────┘ │
│                              │                               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐   │
│  │ Source   │ │ Content  │ │ Memory   │ │ Report       │   │
│  │ Quality  │ │ Fetcher  │ │ Module   │ │ Generator    │   │
│  │ Assessor │ │          │ │(Sessions)│ │ (Citations)  │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Performance Characteristics (from Paper Section 5)

- **90.2% improvement** over single-agent baselines
- **Up to 90% reduction** in task completion time via parallelization
- **Token usage explains 80%** of performance variance
- Model selection explains 5% (upgrading models > doubling tokens)

## Development

```bash
git clone https://github.com/thejusdutt/google-research-mcp.git
cd google-research-mcp
npm install
npm run build
GOOGLE_API_KEY=your-key GOOGLE_CX=your-cx npm start
```

## Changelog

### v1.1.0
- Implemented OODA Loop (Observe-Orient-Decide-Act) from Claude Research paper
- Added two-level parallelization (agent + tool level)
- Added progressive narrowing strategy with dynamic gap identification
- Added session management (Memory Module) for multi-step research
- Added new tools: `web_search`, `research_session`, `add_source`, `get_citations`, `generate_report`
- Improved source quality assessment with more patterns
- Added research statistics tracking (queries, sources, tokens, duration)
- Reports now include OODA iteration logs and knowledge gaps

### v1.0.0
- Initial release with `google_search` and `google_research` tools

## License

MIT

## Credits

- Based on [Anthropic's Claude Research paper](https://www.anthropic.com/engineering/multi-agent-research-system)
- Uses [Model Context Protocol](https://modelcontextprotocol.io/) by Anthropic
- Powered by [Google Custom Search JSON API](https://developers.google.com/custom-search/v1/overview)
