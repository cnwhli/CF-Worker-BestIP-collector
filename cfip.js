// 存储键名
const IP_STORAGE_KEY = "cf_ips";
const LAST_UPDATE_KEY = "last_update";

// IP数据源
const IP_SOURCES = [
  "https://ip.164746.xyz",
  "https://ip.haogege.xyz",
  "https://stock.hostmonit.com/CloudFlareYes",
  "https://api.uouin.com/cloudflare.html",
  "https://addressesapi.090227.xyz",
  "https://www.wetest.vip"
];

// 主处理函数
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 路由处理
    switch (path) {
      case "/":
        return handleHomePage(env);
      case "/ips":
      case "/ip.txt":
        return handleIpText(env);
      case "/raw":
        return handleRawData(env);
      case "/update":
        return handleUpdate(env, request);
      case "/speedtest":
        return handleSpeedTest(url, env);
      case "/itdog-data":
        return handleItdogData(env);
      default:
        return new Response("Not Found", { status: 404 });
    }
  }
};

// 处理主页
async function handleHomePage(env) {
  const ips = JSON.parse(await env.IP_STORAGE.get(IP_STORAGE_KEY) || "[]");
  const lastUpdate = await env.IP_STORAGE.get(LAST_UPDATE_KEY) || "从未更新";
  
  // 生成HTML页面
  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cloudflare 优选IP收集器</title>
    <style>
      body { font-family: Arial, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; }
      .container { margin-top: 20px; }
      .ip-item { padding: 8px; border-bottom: 1px solid #eee; }
      .controls { margin-bottom: 20px; display: flex; gap: 10px; flex-wrap: wrap; }
      button { padding: 8px 16px; cursor: pointer; }
      .stats { color: #666; margin: 10px 0; }
    </style>
  </head>
  <body>
    <h1>Cloudflare 优选IP收集器</h1>
    <div class="stats">
      <p>总IP数: ${ips.length} | 最后更新: ${lastUpdate}</p>
    </div>
    <div class="controls">
      <button onclick="window.location.href='/update'">手动更新IP</button>
      <button onclick="window.location.href='/ips'">下载TXT</button>
      <button onclick="window.location.href='/itdog-data'">ITDog测试</button>
    </div>
    <div id="ip-list">
      ${ips.map(ip => `
        <div class="ip-item">
          ${ip.ip} (延迟: ${ip.delay || '未测试'}ms)
          <button onclick="testSpeed('${ip.ip}')">测速</button>
        </div>
      `).join('')}
    </div>
    <script>
      async function testSpeed(ip) {
        const res = await fetch(\`/speedtest?ip=\${ip}\`);
        const data = await res.json();
        alert(\`IP: \${ip}\n延迟: \${data.delay}ms\`);
        location.reload();
      }
    </script>
  </body>
  </html>
  `;
  
  return new Response(html, {
    headers: { "Content-Type": "text/html;charset=UTF-8" }
  });
}

// 处理IP文本列表
async function handleIpText(env) {
  const ips = JSON.parse(await env.IP_STORAGE.get(IP_STORAGE_KEY) || "[]");
  const text = ips.map(ip => ip.ip).join("\n");
  return new Response(text, {
    headers: { "Content-Type": "text/plain" }
  });
}

// 处理原始JSON数据
async function handleRawData(env) {
  const ips = await env.IP_STORAGE.get(IP_STORAGE_KEY) || "[]";
  return new Response(ips, {
    headers: { "Content-Type": "application/json" }
  });
}

// 处理IP更新
async function handleUpdate(env, request) {
  // 简单鉴权（如果配置了管理员密码）
  if (env.ADMIN_PASSWORD && request.method === "POST") {
    const auth = request.headers.get("Authorization");
    if (auth !== `Bearer ${env.ADMIN_PASSWORD}`) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  // 从数据源收集IP
  const allIps = new Set();
  for (const source of IP_SOURCES) {
    try {
      const res = await fetch(source);
      const text = await res.text();
      // 提取IP地址
      const ips = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
      ips.forEach(ip => allIps.add(ip));
    } catch (e) {
      console.error(`Failed to fetch ${source}: ${e}`);
    }
  }

  // 存储IP数据
  const ipList = Array.from(allIps).map(ip => ({ ip, delay: null }));
  await env.IP_STORAGE.put(IP_STORAGE_KEY, JSON.stringify(ipList));
  await env.IP_STORAGE.put(LAST_UPDATE_KEY, new Date().toLocaleString());

  return new Response("IP updated: " + ipList.length, {
    headers: { "Content-Type": "text/plain" }
  });
}

// 处理测速
async function handleSpeedTest(url, env) {
  const ip = url.searchParams.get("ip");
  if (!ip) return new Response("Missing IP", { status: 400 });

  // 简单延迟测试
  const start = performance.now();
  try {
    await fetch(`https://${ip}`, { 
      timeout: 5000,
      method: "HEAD"
    });
    const delay = Math.round(performance.now() - start);
    
    // 更新存储中的延迟数据
    const ips = JSON.parse(await env.IP_STORAGE.get(IP_STORAGE_KEY) || "[]");
    const updatedIps = ips.map(item => 
      item.ip === ip ? { ...item, delay } : item
    );
    await env.IP_STORAGE.put(IP_STORAGE_KEY, JSON.stringify(updatedIps));
    
    return new Response(JSON.stringify({ ip, delay }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ ip, delay: "超时" }), {
      headers: { "Content-Type": "application/json" }
    });
  }
}

// 处理ITDog数据格式
async function handleItdogData(env) {
  const ips = JSON.parse(await env.IP_STORAGE.get(IP_STORAGE_KEY) || "[]");
  const text = ips.map(ip => `${ip.ip}:443`).join("\n");
  return new Response(text, {
    headers: { "Content-Type": "text/plain" }
  });
}
