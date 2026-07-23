#!/usr/bin/env node

/**
 * EPG 查询 MCP 服务器
 *
 * 提供电视节目指南（EPG）查询功能，数据来源：
 *   https://github.com/CCSH/IPTV
 *
 * 环境变量：
 *   EPG_URL        - 自定义 EPG 数据源 URL（默认：CCSH/IPTV）
 *   EPG_CACHE_TTL  - 缓存时间（分钟，默认 30）
 *   EPG_PORT       - 监听端口（默认 0，随机分配）
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { EpgDataManager } = require('./epg-data.js');

// 初始化数据管理器
const epgUrl = process.env.EPG_URL || undefined;
const cacheTtlMin = parseInt(process.env.EPG_CACHE_TTL || '30', 10);
const epgManager = new EpgDataManager({
  epgUrl,
  cacheTtl: cacheTtlMin * 60 * 1000,
});

// 创建 MCP 服务器
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

/**
 * 工具定义列表
 */
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

/**
 * 工具调用处理
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'list_channels': {
        const keyword = args?.keyword || '';
        const channels = await epgManager.listChannels(keyword);
        return {
          content: [
            {
              type: 'text',
              text: formatChannelList(channels, keyword),
            },
          ],
        };
      }

      case 'get_programmes': {
        if (!args?.channel) {
          throw new Error('缺少必填参数: channel');
        }
        const result = await epgManager.getProgrammes(
          args.channel,
          args.date || undefined,
          args.limit || 200
        );
        return {
          content: [
            {
              type: 'text',
              text: formatProgrammeList(result, args.channel),
            },
          ],
        };
      }

      case 'search_programmes': {
        if (!args?.keyword) {
          throw new Error('缺少必填参数: keyword');
        }
        const result = await epgManager.searchProgrammes(
          args.keyword,
          args.date || undefined,
          args.limit || 50
        );
        return {
          content: [
            {
              type: 'text',
              text: formatSearchResult(result),
            },
          ],
        };
      }

      case 'now_playing': {
        const programmes = await epgManager.getNowPlaying(args?.channel || undefined);
        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        return {
          content: [
            {
              type: 'text',
              text: formatNowPlaying(programmes, timeStr),
            },
          ],
        };
      }

      case 'refresh_data': {
        await epgManager.getData(true);
        return {
          content: [
            {
              type: 'text',
              text: '✅ EPG 数据已刷新',
            },
          ],
        };
      }

      default:
        throw new Error(`未知工具: ${name}`);
    }
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `❌ 错误: ${err.message}`,
        },
      ],
      isError: true,
    };
  }
});

// ========== 格式化输出函数 ==========

function formatChannelList(channels, keyword) {
  if (channels.length === 0) {
    return keyword
      ? `未找到匹配"${keyword}"的频道`
      : '暂无频道数据';
  }

  const lines = [
    `📺 共 ${channels.length} 个频道${keyword ? `（匹配"${keyword}"）` : ''}`,
    '',
    ...channels.map((ch) => `  · ${ch.displayName} (ID: ${ch.id})`),
  ];
  return lines.join('\n');
}

function formatProgrammeList(result, channelQuery) {
  if (result.channels.length === 0) {
    return `未找到匹配"${channelQuery}"的频道`;
  }
  if (result.programmes.length === 0) {
    return `频道 "${result.channels[0].displayName}" 暂无节目数据`;
  }

  const channelName = result.channels[0].displayName;
  const dateLabel = result.programmes[0]?.startTime?.split(' ')[0] || '';
  const lines = [
    `📺 ${channelName} — ${dateLabel} 节目单`,
    result.total > result.programmes.length
      ? `（显示前 ${result.programmes.length} 条，共 ${result.total} 条）`
      : `（共 ${result.total} 条）`,
    '',
  ];

  // 按频道分组
  let currentChannel = '';
  for (const p of result.programmes) {
    if (p.channelName && p.channelName !== currentChannel) {
      currentChannel = p.channelName;
      lines.push(`── ${currentChannel} ──`);
    }
    const time = `${p.startTime} - ${p.stopTime}`;
    lines.push(`  ${time}  ${p.title}`);
  }

  return lines.join('\n');
}

function formatSearchResult(result) {
  if (result.programmes.length === 0) {
    return `未找到匹配"${result.keyword}"的节目`;
  }

  const lines = [
    `🔍 搜索 "${result.keyword}" — 找到 ${result.total} 条结果`,
    result.limited ? `（显示前 ${result.programmes.length} 条）` : '',
    '',
  ];

  for (const p of result.programmes) {
    const time = `${p.startTime} - ${p.stopTime}`;
    lines.push(`  📺 ${p.channelName}`);
    lines.push(`     ${time}`);
    lines.push(`     ${p.title}`);
    if (p.desc) {
      const descShort = p.desc.length > 80 ? p.desc.slice(0, 80) + '…' : p.desc;
      lines.push(`     ${descShort}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatNowPlaying(programmes, timeStr) {
  if (programmes.length === 0) {
    return `📡 当前 (${timeStr}) 暂无正在播放的节目数据`;
  }

  const lines = [
    `📡 当前正在播放 (${timeStr})`,
    '',
  ];

  for (const p of programmes) {
    lines.push(`  📺 ${p.channelName}`);
    lines.push(`     ${p.startTime} - ${p.stopTime}`);
    lines.push(`     ${p.title}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ========== 启动服务 ==========

async function main() {
  // 启动时异步预加载数据
  epgManager.getData().catch((err) => {
    console.error(`[EPG] Initial data fetch failed: ${err.message}`);
    console.error('[EPG] Server will retry on first request');
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[EPG] MCP server started on stdio');
}

main().catch((err) => {
  console.error(`[EPG] Fatal error: ${err.message}`);
  process.exit(1);
});