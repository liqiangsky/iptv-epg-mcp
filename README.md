# 📺 EPG 查询 MCP 服务器

电视节目指南（EPG）查询工具，基于 [Model Context Protocol (MCP)](https://modelcontextprotocol.io) 协议。

数据来源：[CCSH/IPTV](https://github.com/CCSH/IPTV)

## 功能

| 工具 | 说明 |
|------|------|
| `list_channels` | 获取电视频道列表，支持按名称关键词搜索 |
| `get_programmes` | 查询指定频道的节目单，可指定日期 |
| `search_programmes` | 跨频道搜索节目，按节目名称或描述关键词 |
| `now_playing` | 获取当前正在播放的节目列表 |
| `refresh_data` | 强制刷新 EPG 数据缓存 |

## 在 Claude Desktop 中使用

在你的 `claude_desktop_config.json` 中添加：

```json
{
  "mcpServers": {
    "epg-query": {
      "url": "http://localhost:7860/sse"
    }
  }
}
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 监听端口 | `7860` |
| `EPG_URL` | 自定义 EPG 数据源 URL | CCSH/IPTV 默认源 |
| `EPG_CACHE_TTL` | 缓存时间（分钟） | `30` |

## 本地开发

```bash
# 安装依赖
npm install

# 启动 HTTP/SSE 服务
npm start

# 或使用 stdio 模式（原始 MCP 服务器）
npm run start:stdio

# 运行测试
npm test
```

## 技术栈

- **运行时**: Node.js 20
- **协议**: Model Context Protocol (MCP) with SSE Transport
- **框架**: Express.js
- **数据**: XML 解析 + 内存缓存