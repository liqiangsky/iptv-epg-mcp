/**
 * EPG 数据模块快速测试
 */

const { EpgDataManager } = require('./epg-data');

async function main() {
  const manager = new EpgDataManager();

  try {
    // 测试 1: 加载数据
    console.log('=== 测试数据加载 ===');
    const data = await manager.getData();
    console.log(`频道数: ${data.channels.length}`);
    console.log(`节目数: ${data.programmes.length}`);

    // 测试 2: 频道搜索
    console.log('\n=== 测试频道搜索 (CCTV) ===');
    const channels = await manager.listChannels('CCTV');
    console.log(`匹配频道: ${channels.length}`);
    channels.slice(0, 10).forEach((c) => console.log(`  ${c.displayName} (${c.id})`));

    // 测试 3: 获取节目单
    console.log('\n=== 测试节目单查询 (CCTV1) ===');
    const progResult = await manager.getProgrammes('CCTV1');
    console.log(`节目数: ${progResult.total}`);
    progResult.programmes.slice(0, 5).forEach((p) => {
      console.log(`  ${p.startTime} - ${p.stopTime}  ${p.title}`);
    });

    // 测试 4: 关键词搜索
    console.log('\n=== 测试节目搜索 (新闻) ===');
    const searchResult = await manager.searchProgrammes('新闻', undefined, 10);
    console.log(`匹配节目: ${searchResult.total}`);
    searchResult.programmes.forEach((p) => {
      console.log(`  [${p.channelName}] ${p.startTime}  ${p.title}`);
    });

    console.log('\n✅ 所有测试通过');
    process.exit(0);
  } catch (err) {
    console.error('❌ 测试失败:', err.message);
    process.exit(1);
  }
}

main();