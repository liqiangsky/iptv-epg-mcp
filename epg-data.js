/**
 * EPG Data Manager
 * 负责获取、解析、缓存 EPG XML 数据
 */

const https = require('https');
const http = require('http');
const zlib = require('zlib');
const { XMLParser } = require('fast-xml-parser');
const { URL } = require('url');

// 默认数据源
const DEFAULT_EPG_URL = 'https://v4.gh-proxy.org/https://raw.githubusercontent.com/CCSH/IPTV/refs/heads/main/e.xml.gz';

// 缓存配置
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 分钟缓存

/**
 * 带重试的 HTTP GET 请求，返回 Buffer
 */
function fetchBuffer(urlStr, retries = 3, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const transport = url.protocol === 'https:' ? https : http;

    const attempt = (remaining) => {
      const req = transport.get(urlStr, { timeout }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // 处理重定向
          req.destroy();
          return fetchBuffer(res.headers.location, remaining, timeout)
            .then(resolve)
            .catch(reject);
        }
        if (res.statusCode !== 200) {
          req.destroy();
          if (remaining > 0) {
            setTimeout(() => attempt(remaining - 1), 1000);
            return;
          }
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', (err) => {
          if (remaining > 0) {
            setTimeout(() => attempt(remaining - 1), 1000);
          } else {
            reject(err);
          }
        });
      });
      req.on('timeout', () => {
        req.destroy();
        if (remaining > 0) {
          setTimeout(() => attempt(remaining - 1), 1000);
        } else {
          reject(new Error('Request timeout'));
        }
      });
      req.on('error', (err) => {
        if (remaining > 0) {
          setTimeout(() => attempt(remaining - 1), 1000);
        } else {
          reject(err);
        }
      });
    };
    attempt(retries);
  });
}

/**
 * 解析 gzipped XML 数据
 */
function parseEpgXml(xmlBuffer) {
  return new Promise((resolve, reject) => {
    zlib.gunzip(xmlBuffer, (err, decompressed) => {
      if (err) return reject(new Error(`Failed to decompress: ${err.message}`));

      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        textNodeName: '_text',
        isArray: (name) => name === 'channel' || name === 'programme' || name === 'display-name',
      });

      try {
        const result = parser.parse(decompressed.toString('utf-8'));
        const tv = result.tv;
        if (!tv) throw new Error('No <tv> root element found');

        // 解析频道列表
        const channels = (tv.channel || []).map((ch) => ({
          id: String(ch['@_id'] || ''),
          displayName: (ch['display-name'] || [])
            .map((d) => d._text || d || '')
            .filter(Boolean)
            .join(' / '),
        }));

        // 建立 id -> displayName 映射
        const channelNameMap = {};
        for (const ch of channels) {
          channelNameMap[ch.id] = ch.displayName;
        }

        // 解析节目列表
        const programmes = (tv.programme || []).map((prog) => {
          const rawTitle = prog.title;
          const rawDesc = prog.desc;
          return {
            channelId: String(prog['@_channel'] || ''),
            channelName: channelNameMap[String(prog['@_channel'] || '')] || '',
            start: prog['@_start'] || '',
            stop: prog['@_stop'] || '',
            title: String(rawTitle && typeof rawTitle === 'object' ? (rawTitle._text ?? '') : (rawTitle ?? '')),
            desc: String(rawDesc && typeof rawDesc === 'object' ? (rawDesc._text ?? '') : (rawDesc ?? '')),
          };
        });

        resolve({ channels, programmes, channelNameMap });
      } catch (parseErr) {
        reject(new Error(`XML parse error: ${parseErr.message}`));
      }
    });
  });
}

/**
 * 将 "20260720004800 +0800" 格式解析为 Date 对象
 */
function parseEpgTime(timeStr) {
  if (!timeStr) return null;
  const match = timeStr.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?$/);
  if (!match) return null;
  const [, y, m, d, h, min, s, tz] = match;
  // 构造 ISO 字符串
  let isoStr = `${y}-${m}-${d}T${h}:${min}:${s}`;
  if (tz) {
    const tzHours = tz.slice(0, 3);
    const tzMin = tz.slice(3);
    isoStr += `${tzHours}:${tzMin}`;
  } else {
    isoStr += '+08:00';
  }
  return new Date(isoStr);
}

/**
 * 格式化时间为 YYYY-MM-DD HH:mm 格式
 */
function formatTime(date) {
  if (!date || isNaN(date.getTime())) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}`;
}

class EpgDataManager {
  constructor(options = {}) {
    this.epgUrl = options.epgUrl || DEFAULT_EPG_URL;
    this.cacheTtl = options.cacheTtl || CACHE_TTL_MS;
    this.cachedData = null;
    this.lastFetchTime = 0;
    this.fetchPromise = null;
  }

  /**
   * 获取 EPG 数据，优先使用缓存
   */
  async getData(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && this.cachedData && (now - this.lastFetchTime) < this.cacheTtl) {
      return this.cachedData;
    }

    // 防止并发请求
    if (this.fetchPromise) {
      return this.fetchPromise;
    }

    this.fetchPromise = this._fetchAndParse()
      .then((data) => {
        this.cachedData = data;
        this.lastFetchTime = Date.now();
        this.fetchPromise = null;
        return data;
      })
      .catch((err) => {
        this.fetchPromise = null;
        // 如果有缓存数据，即使过期也返回
        if (this.cachedData) {
          console.error(`[EPG] Fetch failed, using stale cache: ${err.message}`);
          return this.cachedData;
        }
        throw err;
      });

    return this.fetchPromise;
  }

  async _fetchAndParse() {
    console.error(`[EPG] Fetching data from ${this.epgUrl}...`);
    const buffer = await fetchBuffer(this.epgUrl);
    console.error(`[EPG] Received ${(buffer.length / 1024).toFixed(0)} KB`);
    const data = await parseEpgXml(buffer);
    console.error(`[EPG] Parsed: ${data.channels.length} channels, ${data.programmes.length} programmes`);
    return data;
  }

  /**
   * 获取所有频道列表
   */
  async listChannels(keyword = '') {
    const data = await this.getData();
    let channels = data.channels;
    if (keyword) {
      const kw = keyword.toLowerCase();
      channels = channels.filter(
        (ch) => ch.displayName.toLowerCase().includes(kw) || ch.id.includes(kw)
      );
    }
    return channels;
  }

  /**
   * 根据频道 ID 或名称查询节目单
   * @param {string} channelQuery - 频道 ID 或名称（支持模糊匹配）
   * @param {string} [date] - 日期 YYYY-MM-DD，不传则查当天
   * @param {number} [limit] - 返回条数上限
   */
  async getProgrammes(channelQuery, date, limit = 200) {
    const data = await this.getData();

    // 查找匹配的频道
    const cq = channelQuery.toLowerCase();
    const matchedChannels = data.channels.filter(
      (ch) => ch.id === cq || ch.displayName.toLowerCase().includes(cq)
    );
    if (matchedChannels.length === 0) {
      return { channels: [], programmes: [] };
    }

    const matchedIds = new Set(matchedChannels.map((ch) => ch.id));

    // 日期过滤
    let dateStart, dateEnd;
    if (date) {
      dateStart = new Date(`${date}T00:00:00+08:00`);
      dateEnd = new Date(`${date}T23:59:59+08:00`);
    } else {
      const now = new Date();
      // 取当天北京时间
      dateStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      dateEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    }

    const programmes = data.programmes.filter((p) => {
      if (!matchedIds.has(p.channelId)) return false;
      const startTime = parseEpgTime(p.start);
      if (!startTime) return false;
      // 节目开始时间在日期范围内，或节目跨越这一天
      return startTime >= dateStart && startTime <= dateEnd;
    });

    // 按频道和时间排序
    programmes.sort((a, b) => {
      if (a.channelId !== b.channelId) return a.channelId.localeCompare(b.channelId);
      return a.start.localeCompare(b.start);
    });

    // 附加格式化时间
    const result = programmes.map((p) => ({
      ...p,
      startTime: formatTime(parseEpgTime(p.start)),
      stopTime: formatTime(parseEpgTime(p.stop)),
    }));

    const limited = limit > 0 ? result.slice(0, limit) : result;

    return {
      channels: matchedChannels,
      programmes: limited,
      total: result.length,
      limited: result.length > limit,
    };
  }

  /**
   * 跨频道搜索节目
   * @param {string} keyword - 搜索关键词
   * @param {string} [date] - 可选日期过滤 YYYY-MM-DD
   * @param {number} [limit] - 返回条数上限
   */
  async searchProgrammes(keyword, date, limit = 50) {
    const data = await this.getData();
    const kw = keyword.toLowerCase();

    let programmes = data.programmes.filter((p) => {
      const matchesTitle = p.title.toLowerCase().includes(kw);
      const matchesDesc = p.desc.toLowerCase().includes(kw);
      return matchesTitle || matchesDesc;
    });

    // 日期过滤
    if (date) {
      const dateStart = new Date(`${date}T00:00:00+08:00`);
      const dateEnd = new Date(`${date}T23:59:59+08:00`);
      programmes = programmes.filter((p) => {
        const startTime = parseEpgTime(p.start);
        return startTime && startTime >= dateStart && startTime <= dateEnd;
      });
    }

    // 去重：同一频道同一时间同一标题的只保留一条
    const seen = new Set();
    programmes = programmes.filter((p) => {
      const key = `${p.channelId}|${p.start}|${p.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // 按时间排序
    programmes.sort((a, b) => a.start.localeCompare(b.start));

    const result = programmes.map((p) => ({
      ...p,
      startTime: formatTime(parseEpgTime(p.start)),
      stopTime: formatTime(parseEpgTime(p.stop)),
    }));

    const limited = limit > 0 ? result.slice(0, limit) : result;

    return {
      keyword,
      programmes: limited,
      total: result.length,
      limited: result.length > limit,
    };
  }

  /**
   * 获取当前正在播放的节目
   * @param {string} [channelQuery] - 可选频道过滤
   */
  async getNowPlaying(channelQuery) {
    const data = await this.getData();
    const now = new Date();

    let programmes = data.programmes.filter((p) => {
      const startTime = parseEpgTime(p.start);
      const stopTime = parseEpgTime(p.stop);
      if (!startTime || !stopTime) return false;
      return startTime <= now && stopTime > now;
    });

    if (channelQuery) {
      const cq = channelQuery.toLowerCase();
      programmes = programmes.filter(
        (p) => p.channelId === cq || p.channelName.toLowerCase().includes(cq)
      );
    }

    programmes.sort((a, b) => a.channelId.localeCompare(b.channelId));

    return programmes.map((p) => ({
      ...p,
      startTime: formatTime(parseEpgTime(p.start)),
      stopTime: formatTime(parseEpgTime(p.stop)),
    }));
  }
}

module.exports = { EpgDataManager, parseEpgTime, formatTime };
