#!/usr/bin/env node

/**
 * EPG 查询 MCP 服务器 — HTTP/SSE 模式
 *
 * 将 MCP stdio 服务包装为 HTTP/SSE 传输层，支持远程访问。
 *
 * 环境变量：
 *   PORT           - 监听端口（默认 7860）
 *   EPG_URL        - 自定义 EPG 数据源 URL
 *   EPG_CACHE_TTL  - 缓存时间（分钟，默认 30）
 */

const express = require('express');
const cors = require('cors');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { EpgDataManager } = require('./epg-data.js');

const PORT = parseInt(process.env.PORT || '7860', 10);
const epgUrl = process.env.EPG_URL || undefined;
const cacheTtlMin = parseInt(process.env.EPG_CACHE_TTL || '30', 10);

// ========== 初始化 MCP 服务器 ==========

const epgManager = new EpgDataManager({
  epgUrl,
  cacheTtl: cacheTtlMin * 60 * 1000,
});

const server = new Server(
  {
    name: 'epg-query-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 工具定义
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'list_channels',
        description: '获取所有电视频道列表，可按名称关键词筛选',
        inputSchema: {
          type: 'object',
          properties: {
            keyword: {
              type: 'string',
              description: '搜索关键词（可选），按频道名称或 ID 模糊搜索',
            },
          },
        },
      },
      {
        name: 'get_programmes',
        description: '查询指定频道的节目单，可指定日期',
        inputSchema: {
          type: 'object',
          properties: {
            channel: {
              type: 'string',
              description: '频道名称或 ID（支持模糊匹配），例如 "CCTV1"、"湖南卫视"',
            },
            date: {
              type: 'string',
              description: '日期（可选），格式 YYYY-MM-DD，不传则查当天节目',
            },
            limit: {
              type: 'number',
              description: '返回条数上限（可选，默认 200）',
            },
          },
          required: ['channel'],
        },
      },
      {
        name: 'search_programmes',
        description: '跨频道搜索节目，按节目名称或描述关键词搜索',
        inputSchema: {
          type: 'object',
          properties: {
            keyword: {
              type: 'string',
              description: '搜索关键词，用于匹配节目名称或描述',
            },
            date: {
              type: 'string',
              description: '日期（可选），格式 YYYY-MM-DD，不传则搜索所有日期',
            },
            limit: {
              type: 'number',
              description: '返回条数上限（可选，默认 50）',
            },
          },
          required: ['keyword'],
        },
      },
      {
        name: 'now_playing',
        description: '获取当前正在播放的节目列表',
        inputSchema: {
          type: 'object',
          properties: {
            channel: {
              type: 'string',
              description: '频道名称或 ID（可选），不传则返回所有频道当前节目',
            },
          },
        },
      },
      {
        name: 'refresh_data',
        description: '强制刷新 EPG 数据缓存，从远程重新获取最新数据',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };
});

// 工具调用处理
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case 'list_channels': {
        const keyword = args?.keyword || '';
        const channels = await epgManager.listChannels(keyword);
        return {
          content: [{ type: 'text', text: formatChannelList(channels, keyword) }],
        };
      }
      case 'get_programmes': {
        if (!args?.channel) throw new Error('缺少必填参数: channel');
        const result = await epgManager.getProgrammes(args.channel, args.date || undefined, args.limit || 200);
        return {
          content: [{ type: 'text', text: formatProgrammeList(result, args.channel) }],
        };
      }
      case 'search_programmes': {
        if (!args?.keyword) throw new Error('缺少必填参数: keyword');
        const result = await epgManager.searchProgrammes(args.keyword, args.date || undefined, args.limit || 50);
        return {
          content: [{ type: 'text', text: formatSearchResult(result) }],
        };
      }
      case 'now_playing': {
        const programmes = await epgManager.getNowPlaying(args?.channel || undefined);
        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        return {
          content: [{ type: 'text', text: formatNowPlaying(programmes, timeStr) }],
        };
      }
      case 'refresh_data': {
        await epgManager.getData(true);
        return { content: [{ type: 'text', text: '✅ EPG 数据已刷新' }] };
      }
      default:
        throw new Error(`未知工具: ${name}`);
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `❌ 错误: ${err.message}` }], isError: true };
  }
});

// ========== 格式化输出函数 ==========

function formatChannelList(channels, keyword) {
  if (channels.length === 0) return keyword ? `未找到匹配"${keyword}"的频道` : '暂无频道数据';
  const lines = [
    `📺 共 ${channels.length} 个频道${keyword ? `（匹配"${keyword}"）` : ''}`,
    '',
    ...channels.map((ch) => `  · ${ch.displayName} (ID: ${ch.id})`),
  ];
  return lines.join('\n');
}

function formatProgrammeList(result, channelQuery) {
  if (result.channels.length === 0) return `未找到匹配"${channelQuery}"的频道`;
  if (result.programmes.length === 0) return `频道 "${result.channels[0].displayName}" 暂无节目数据`;
  const channelName = result.channels[0].displayName;
  const dateLabel = result.programmes[0]?.startTime?.split(' ')[0] || '';
  const lines = [
    `📺 ${channelName} — ${dateLabel} 节目单`,
    result.total > result.programmes.length
      ? `（显示前 ${result.programmes.length} 条，共 ${result.total} 条）`
      : `（共 ${result.total} 条）`,
    '',
  ];
  let currentChannel = '';
  for (const p of result.programmes) {
    if (p.channelName && p.channelName !== currentChannel) {
      currentChannel = p.channelName;
      lines.push(`── ${currentChannel} ──`);
    }
    lines.push(`  ${p.startTime} - ${p.stopTime}  ${p.title}`);
  }
  return lines.join('\n');
}

function formatSearchResult(result) {
  if (result.programmes.length === 0) return `未找到匹配"${result.keyword}"的节目`;
  const lines = [
    `🔍 搜索 "${result.keyword}" — 找到 ${result.total} 条结果`,
    result.limited ? `（显示前 ${result.programmes.length} 条）` : '',
    '',
  ];
  for (const p of result.programmes) {
    lines.push(`  📺 ${p.channelName}`);
    lines.push(`     ${p.startTime} - ${p.stopTime}`);
    lines.push(`     ${p.title}`);
    if (p.desc) {
      lines.push(`     ${p.desc.length > 80 ? p.desc.slice(0, 80) + '…' : p.desc}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function formatNowPlaying(programmes, timeStr) {
  if (programmes.length === 0) return `📡 当前 (${timeStr}) 暂无正在播放的节目数据`;
  const lines = [`📡 当前正在播放 (${timeStr})`, ''];
  for (const p of programmes) {
    lines.push(`  📺 ${p.channelName}`);
    lines.push(`     ${p.startTime} - ${p.stopTime}`);
    lines.push(`     ${p.title}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ========== Express HTTP 服务器 ==========

const app = express();

app.use(cors());
app.use(express.json());

// 存储活跃的 SSE 传输实例
const sessions = new Map();

/**
 * GET /sse — MCP SSE 端点
 * MCP 客户端通过此端点建立 SSE 连接
 */
app.get('/sse', async (req, res) => {
  const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  console.error(`[SSE] New session: ${sessionId}`);

  const transport = new SSEServerTransport('/messages', res);
  sessions.set(sessionId, transport);

  // 连接断开时清理
  res.on('close', () => {
    console.error(`[SSE] Session closed: ${sessionId}`);
    sessions.delete(sessionId);
  });

  await server.connect(transport);
});

/**
 * POST /messages — MCP 消息端点
 * 客户端通过此端点发送 JSON-RPC 消息
 */
app.post('/messages', async (req, res) => {
  // 从查询参数获取 sessionId
  const sessionId = req.query.sessionId;
  if (!sessionId) {
    return res.status(400).json({ error: 'Missing sessionId query parameter' });
  }
  const transport = sessions.get(sessionId);
  if (!transport) {
    return res.status(404).json({ error: 'Session not found' });
  }
  await transport.handlePostMessage(req, res);
});

/**
 * GET / — 状态页面
 * 显示服务运行状态和基本信息
 */
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EPG 查询 MCP 服务器</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    .container {
      max-width: 720px;
      width: 100%;
    }
    .card {
      background: #1e293b;
      border-radius: 16px;
      padding: 2.5rem;
      box-shadow: 0 4px 24px rgba(0,0,0,0.3);
    }
    h1 {
      font-size: 1.75rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .subtitle {
      color: #94a3b8;
      margin-bottom: 2rem;
      font-size: 0.95rem;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background: #065f46;
      color: #6ee7b7;
      padding: 0.35rem 1rem;
      border-radius: 999px;
      font-size: 0.85rem;
      font-weight: 600;
      margin-bottom: 1.5rem;
    }
    .status::before {
      content: '';
      display: inline-block;
      width: 8px;
      height: 8px;
      background: #34d399;
      border-radius: 50%;
      animation: pulse 2s infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .info-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .info-item {
      background: #0f172a;
      border-radius: 10px;
      padding: 1rem;
    }
    .info-item .label {
      font-size: 0.75rem;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 0.25rem;
    }
    .info-item .value {
      font-size: 1.1rem;
      font-weight: 600;
    }
    .tools-section {
      margin-top: 1.5rem;
    }
    .tools-section h2 {
      font-size: 1.1rem;
      margin-bottom: 0.75rem;
    }
    .tool-list {
      list-style: none;
    }
    .tool-list li {
      padding: 0.5rem 0;
      border-bottom: 1px solid #334155;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .tool-list li:last-child { border-bottom: none; }
    .tool-tag {
      background: #334155;
      color: #93c5fd;
      font-size: 0.7rem;
      padding: 0.15rem 0.5rem;
      border-radius: 4px;
      font-family: monospace;
      white-space: nowrap;
    }
    .mcp-config {
      margin-top: 2rem;
      background: #0f172a;
      border-radius: 10px;
      padding: 1.25rem;
    }
    .mcp-config h3 {
      font-size: 0.9rem;
      margin-bottom: 0.75rem;
      color: #94a3b8;
    }
    pre {
      background: #020617;
      padding: 1rem;
      border-radius: 8px;
      font-size: 0.8rem;
      overflow-x: auto;
      color: #a5b4fc;
      line-height: 1.5;
    }
    .footer {
      margin-top: 1.5rem;
      text-align: center;
      color: #475569;
      font-size: 0.8rem;
    }
    .footer a { color: #60a5fa; text-decoration: none; }
    .footer a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>📺 EPG 查询 MCP 服务器</h1>
      <p class="subtitle">电视节目指南 · Model Context Protocol</p>
      <div class="status">服务运行中</div>

      <div class="info-grid">
        <div class="info-item">
          <div class="label">版本</div>
          <div class="value">1.0.0</div>
        </div>
        <div class="info-item">
          <div class="label">传输协议</div>
          <div class="value">HTTP/SSE</div>
        </div>
        <div class="info-item">
          <div class="label">MCP 端点</div>
          <div class="value" style="font-size:0.9rem;word-break:break-all;">/sse</div>
        </div>
        <div class="info-item">
          <div class="label">消息端点</div>
          <div class="value" style="font-size:0.9rem;word-break:break-all;">POST /messages</div>
        </div>
      </div>

      <div class="tools-section">
        <h2>🛠 可用工具</h2>
        <ul class="tool-list">
          <li><span class="tool-tag">list_channels</span> 获取频道列表，支持关键词筛选</li>
          <li><span class="tool-tag">get_programmes</span> 查询指定频道的节目单</li>
          <li><span class="tool-tag">search_programmes</span> 跨频道搜索节目</li>
          <li><span class="tool-tag">now_playing</span> 获取当前正在播放的节目</li>
          <li><span class="tool-tag">refresh_data</span> 强制刷新 EPG 数据缓存</li>
        </ul>
      </div>

      <div class="mcp-config">
        <h3>🔌 Claude Desktop 配置</h3>
        <pre>{
  "mcpServers": {
    "epg-query": {
      "url": "https://${req.headers.host || 'localhost'}/sse"
    }
  }
}</pre>
      </div>
    </div>
    <div class="footer">
      数据来源：<a href="https://github.com/CCSH/IPTV" target="_blank" rel="noopener">CCSH/IPTV</a>
    </div>
  </div>
</body>
</html>`);
});

// ========== 启动服务 ==========

async function main() {
  // 预加载数据
  epgManager.getData().catch((err) => {
    console.error(`[EPG] Initial data fetch failed: ${err.message}`);
    console.error('[EPG] Server will retry on first request');
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.error(`[EPG] HTTP server listening on http://0.0.0.0:${PORT}`);
    console.error(`[EPG] SSE endpoint:  http://0.0.0.0:${PORT}/sse`);
    console.error(`[EPG] Status page:  http://0.0.0.0:${PORT}/`);
  });
}

main().catch((err) => {
  console.error(`[EPG] Fatal error: ${err.message}`);
  process.exit(1);
});