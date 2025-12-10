const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3000;

// 跨域配置
app.use(cors());
// 静态文件托管（前端页面）
app.use(express.static(path.join(__dirname, 'public')));
// JSON 解析中间件
app.use(express.json());

// 模拟存储（生产环境可替换为 Redis/MongoDB）
let ipStorage = {
  ips: [],
  lastUpdated: Date.now()
};

// IP 国家信息缓存（避免重复查询）
const ipCountryCache = new Map();

/**
 * 获取 IP 对应的国家信息
 * @param {string} ip - 待查询的 IP 地址
 * @returns {string} 国家名称（未知/具体国家）
 */
async function getIpCountry(ip) {
  // 优先从缓存获取
  if (ipCountryCache.has(ip)) {
    return ipCountryCache.get(ip);
  }

  try {
    // 调用 ip-api.com 接口（免费，限制每分钟45次）
    const response = await fetch(`http://ip-api.com/json/${ip}?fields=country,status`, {
      timeout: 5000
    });
    const data = await response.json();

    let country = '未知';
    if (data.status === 'success' && data.country) {
      country = data.country;
    }

    // 缓存结果（有效期1小时）
    ipCountryCache.set(ip, country);
    setTimeout(() => ipCountryCache.delete(ip), 3600 * 1000);

    return country;
  } catch (error) {
    console.error(`查询IP ${ip} 国家失败:`, error);
    return '未知';
  }
}

/**
 * 收集 Cloudflare IP 示例（可替换为实际IP来源）
 */
async function collectCloudflareIps() {
  try {
    // 示例：获取 Cloudflare 公开IP列表（实际可替换为你的IP来源）
    const response = await fetch('https://www.cloudflare.com/cdn-cgi/trace', { timeout: 5000 });
    const text = await response.text();
    const clientIp = text.match(/ip=([\d\.]+)/)?.[1] || '1.1.1.1';

    // 模拟多个IP（实际可批量获取）
    const testIps = [clientIp, '8.8.8.8', '2.2.2.2', '14.14.14.14', '9.9.9.9'];
    const ipList = [];

    for (const ip of testIps) {
      const country = await getIpCountry(ip);
      // 模拟延迟（实际可ping测试）
      const delay = Math.floor(Math.random() * 100) + 10;
      ipList.push({ ip, country, delay, timestamp: Date.now() });
    }

    // 更新存储
    ipStorage = {
      ips: ipList,
      lastUpdated: Date.now()
    };

    return ipList;
  } catch (error) {
    console.error('收集IP失败:', error);
    return [];
  }
}

// 接口1：手动触发IP收集
app.get('/api/collect-ips', async (req, res) => {
  try {
    const ips = await collectCloudflareIps();
    res.json({
      code: 200,
      message: 'IP收集成功',
      data: ips
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: 'IP收集失败',
      error: error.message
    });
  }
});

// 接口2：获取筛选后的IP列表（支持按国家筛选）
app.get('/api/ips', async (req, res) => {
  try {
    const { country = 'all' } = req.query;
    let filteredIps = [...ipStorage.ips];

    // 按国家筛选
    if (country && country !== 'all') {
      filteredIps = filteredIps.filter(item => item.country === country);
    }

    res.json({
      code: 200,
      data: {
        ips: filteredIps,
        lastUpdated: ipStorage.lastUpdated,
        total: filteredIps.length
      }
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      message: '获取IP列表失败',
      error: error.message
    });
  }
});

// 启动服务
app.listen(PORT, () => {
  console.log(`服务已启动：http://localhost:${PORT}`);
  // 启动时自动收集一次IP
  collectCloudflareIps();
});
