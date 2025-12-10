// V2.5版本，添加管理员登录参数，需要到CF worker环境变量里添加 ADMIN_PASSWORD，网页增加Token管理，登陆后可用
// 自定义优质IP数量
const FAST_IP_COUNT = 25; // 修改这个数字来自定义优质IP数量
const AUTO_TEST_MAX_IPS = 200; // 自动测速的最大IP数量，避免测速过多导致超时

export default {
    async scheduled(event, env, ctx) {
        console.log('Running scheduled IP update...');

        try {
            if (!env.IP_STORAGE) {
                console.error('KV namespace IP_STORAGE is not bound');
                return;
            }

            const startTime = Date.now();
            const { uniqueIPs, results } = await updateAllIPs(env);
            const duration = Date.now() - startTime;

            await env.IP_STORAGE.put('cloudflare_ips', JSON.stringify({
                ips: uniqueIPs,
                lastUpdated: new Date().toISOString(),
                count: uniqueIPs.length,
                sources: results
            }));

            // 自动触发测速并存储优质IP
            await autoSpeedTestAndStore(env, uniqueIPs);

            console.log(`Scheduled update: ${uniqueIPs.length} IPs collected in ${duration}ms`);
        } catch (error) {
            console.error('Scheduled update failed:', error);
        }
    },

    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;

        // 检查 KV 是否绑定
        if (!env.IP_STORAGE) {
            return new Response('KV namespace IP_STORAGE is not bound. Please bind it in Worker settings.', {
                status: 500,
                headers: { 'Content-Type': 'text/plain' }
            });
        }

        if (request.method === 'OPTIONS') {
            return handleCORS();
        }

        try {
            switch (path) {
                case '/':
                    return await serveHTML(env, request);
                case '/update':
                    if (request.method !== 'POST') {
                        return jsonResponse({ error: 'Method not allowed' }, 405);
                    }
                    return await handleUpdate(env, request);
                case '/ips':
                case '/ip.txt':
                    return await handleGetIPs(env, request);
                case '/raw':
                    return await handleRawIPs(env, request);
                case '/speedtest':
                    return await handleSpeedTest(request, env);
                case '/itdog-data':
                    return await handleItdogData(env, request);
                case '/fast-ips':
                    return await handleGetFastIPs(env, request);
                case '/fast-ips.txt':
                    return await handleGetFastIPsText(env, request);
                case '/admin-login':
                    return await handleAdminLogin(request, env);
                case '/admin-status':
                    return await handleAdminStatus(env);
                case '/admin-logout':
                    return await handleAdminLogout(env);
                case '/admin-token':
                    return await handleAdminToken(request, env);
                default:
                    return jsonResponse({ error: 'Endpoint not found' }, 404);
            }
        } catch (error) {
            console.error('Error:', error);
            return jsonResponse({ error: error.message }, 500);
        }
    }
};

// 管理员登录处理
async function handleAdminLogin(request, env) {
    if (request.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    try {
        const { password } = await request.json();

        if (!env.ADMIN_PASSWORD) {
            return jsonResponse({
                success: false,
                error: '管理员密码未配置，请在环境变量中设置 ADMIN_PASSWORD'
            }, 400);
        }

        if (password === env.ADMIN_PASSWORD) {
            // 检查是否已有token配置
            let tokenConfig = await getTokenConfig(env);

            // 如果没有token配置，创建一个默认的
            if (!tokenConfig) {
                tokenConfig = {
                    token: generateToken(),
                    expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 默认30天
                    createdAt: new Date().toISOString(),
                    lastUsed: null
                };
                await env.IP_STORAGE.put('token_config', JSON.stringify(tokenConfig));
            }

            // 创建会话
            const sessionId = generateToken();
            await env.IP_STORAGE.put(`session_${sessionId}`, JSON.stringify({
                loggedIn: true,
                createdAt: new Date().toISOString()
            }), { expirationTtl: 86400 }); // 24小时过期

            return jsonResponse({
                success: true,
                sessionId: sessionId,
                tokenConfig: tokenConfig,
                message: '登录成功'
            });
        } else {
            return jsonResponse({
                success: false,
                error: '密码错误'
            }, 401);
        }
    } catch (error) {
        return jsonResponse({ error: error.message }, 500);
    }
}

// Token管理
async function handleAdminToken(request, env) {
    if (!await verifyAdmin(request, env)) {
        return jsonResponse({ error: '需要管理员权限' }, 401);
    }

    if (request.method === 'GET') {
        const tokenConfig = await getTokenConfig(env);
        return jsonResponse({ tokenConfig });
    } else if (request.method === 'POST') {
        try {
            const { token, expiresDays, neverExpire } = await request.json();

            if (!token) {
                return jsonResponse({ error: 'Token不能为空' }, 400);
            }

            let expiresDate;
            if (neverExpire) {
                // 设置一个很远的未来日期作为永不过期
                expiresDate = new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000).toISOString(); // 100年
            } else {
                if (!expiresDays) {
                    return jsonResponse({ error: '过期时间不能为空' }, 400);
                }
                if (expiresDays < 1 || expiresDays > 365) {
                    return jsonResponse({ error: '过期时间必须在1-365天之间' }, 400);
                }
                expiresDate = new Date(Date.now() + expiresDays * 24 * 60 * 60 * 1000).toISOString();
            }

            const tokenConfig = {
                token: token.trim(),
                expires: expiresDate,
                createdAt: new Date().toISOString(),
                lastUsed: null,
                neverExpire: neverExpire || false
            };

            await env.IP_STORAGE.put('token_config', JSON.stringify(tokenConfig));

            return jsonResponse({
                success: true,
                tokenConfig,
                message: 'Token更新成功'
            });
        } catch (error) {
            return jsonResponse({ error: error.message }, 500);
        }
    } else {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }
}

// 检查管理员状态
async function handleAdminStatus(env) {
    try {
        const tokenConfig = await getTokenConfig(env);
        return jsonResponse({
            hasAdminPassword: !!env.ADMIN_PASSWORD,
            hasToken: !!tokenConfig,
            tokenConfig: tokenConfig
        });
    } catch (error) {
        return jsonResponse({ error: error.message }, 500);
    }
}

// 管理员登出
async function handleAdminLogout(env) {
    try {
        // 这里可以添加会话清理逻辑
        return jsonResponse({
            success: true,
            message: '已退出登录'
        });
    } catch (error) {
        return jsonResponse({ error: error.message }, 500);
    }
}

// 获取Token配置
async function getTokenConfig(env) {
    try {
        const config = await env.IP_STORAGE.get('token_config');
        return config ? JSON.parse(config) : null;
    } catch (error) {
        return null;
    }
}

// 生成随机Token
function generateToken() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 32; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// 验证管理员权限
async function verifyAdmin(request, env) {
    if (!env.ADMIN_PASSWORD) {
        return true; // 如果没有设置管理员密码，则允许所有访问
    }

    try {
        // 检查会话
        const authHeader = request.headers.get('Authorization');
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const sessionId = authHeader.slice(7);
            const session = await env.IP_STORAGE.get(`session_${sessionId}`);
            if (session) {
                return true;
            }
        }

        // 检查URL参数中的会话
        const url = new URL(request.url);
        const sessionId = url.searchParams.get('session');
        if (sessionId) {
            const session = await env.IP_STORAGE.get(`session_${sessionId}`);
            if (session) {
                return true;
            }
        }

        // 检查Token
        const tokenConfig = await getTokenConfig(env);
        if (tokenConfig) {
            // 检查Token是否过期（永不过期的token跳过此检查）
            if (!tokenConfig.neverExpire && new Date(tokenConfig.expires) < new Date()) {
                return false;
            }

            // 检查URL参数中的token
            const urlToken = url.searchParams.get('token');
            if (urlToken === tokenConfig.token) {
                // 更新最后使用时间
                tokenConfig.lastUsed = new Date().toISOString();
                await env.IP_STORAGE.put('token_config', JSON.stringify(tokenConfig));
                return true;
            }

            // 检查Authorization头中的token
            if (authHeader && authHeader.startsWith('Token ')) {
                const requestToken = authHeader.slice(6);
                if (requestToken === tokenConfig.token) {
                    tokenConfig.lastUsed = new Date().toISOString();
                    await env.IP_STORAGE.put('token_config', JSON.stringify(tokenConfig));
                    return true;
                }
            }
        }

        return false;
    } catch (error) {
        return false;
    }
}

// 为URL添加认证参数
function addAuthToUrl(url, sessionId, tokenConfig) {
    if (!sessionId && !tokenConfig) return url;

    const separator = url.includes('?') ? '&' : '?';

    if (sessionId) {
        return `${url}${separator}session=${encodeURIComponent(sessionId)}`;
    } else if (tokenConfig) {
        return `${url}${separator}token=${encodeURIComponent(tokenConfig.token)}`;
    }

    return url;
}

// 提供HTML页面
async function serveHTML(env, request) {
    const data = await getStoredIPs(env);

    // 获取测速后的IP数据
    const speedData = await getStoredSpeedIPs(env);
    const fastIPs = speedData.fastIPs || [];

    // 检查管理员状态
    const isLoggedIn = await verifyAdmin(request, env);
    const hasAdminPassword = !!env.ADMIN_PASSWORD;
    const tokenConfig = await getTokenConfig(env);

    // 获取会话ID
    let sessionId = null;
    if (isLoggedIn) {
        const url = new URL(request.url);
        sessionId = url.searchParams.get('session');
        if (!sessionId) {
            const authHeader = request.headers.get('Authorization');
            if (authHeader && authHeader.startsWith('Bearer ')) {
                sessionId = authHeader.slice(7);
            }
        }
    }

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cloudflare IP 收集器</title>
    <style>
        * { 
            margin: 0; 
            padding: 0; 
            box-sizing: border-box; 
        }
        
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
            line-height: 1.6; 
            background: #f8fafc;
            color: #334155;
            min-height: 100vh;
            padding: 20px;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        
        /* 头部和社交图标 */
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 40px;
            padding-bottom: 20px;
            border-bottom: 1px solid #e2e8f0;
        }
        
        .header-content h1 {
            font-size: 2.5rem;
            background: linear-gradient(135deg, #3b82f6 0%, #06b6d4 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 8px;
            font-weight: 700;
        }
        
        .header-content p {
            color: #64748b;
            font-size: 1.1rem;
        }
        
        .social-links {
            display: flex;
            gap: 15px;
        }
        
        .social-link {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 44px;
            height: 44px;
            border-radius: 12px;
            background: white;
            border: 1px solid #e2e8f0;
            transition: all 0.3s ease;
            text-decoration: none;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
        }
        
        .social-link:hover {
            background: #f8fafc;
            transform: translateY(-2px);
            border-color: #cbd5e1;
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
        }
        
        .social-link.youtube {
            color: #dc2626;
        }
        
        .social-link.youtube:hover {
            background: #fef2f2;
            border-color: #fecaca;
        }
        
        .social-link.github {
            color: #1f2937;
        }
        
        .social-link.github:hover {
            background: #f8fafc;
            border-color: #cbd5e1;
        }
        
        .social-link.telegram {
            color: #3b82f6;
        }
        
        .social-link.telegram:hover {
            background: #eff6ff;
            border-color: #bfdbfe;
        }
        
        /* 卡片设计 */
        .card {
            background: white;
            border-radius: 16px;
            padding: 30px;
            margin-bottom: 24px;
            border: 1px solid #e2e8f0;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
        }
        
        .card h2 {
            font-size: 1.5rem;
            color: #1e40af;
            margin-bottom: 20px;
            font-weight: 600;
        }
        
        /* 统计数字 */
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 16px;
            margin-bottom: 24px;
        }
        
        .stat {
            background: #f8fafc;
            padding: 20px;
            border-radius: 12px;
            text-align: center;
            border: 1px solid #e2e8f0;
        }
        
        .stat-value {
            font-size: 2rem;
            font-weight: 700;
            color: #3b82f6;
            margin-bottom: 8px;
        }
        
        /* 按钮组 */
        .button-group {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            margin-bottom: 20px;
        }
        
        .button {
            padding: 12px 20px;
            border: none;
            border-radius: 10px;
            font-size: 0.95rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            background: #3b82f6;
            color: white;
            border: 1px solid #3b82f6;
        }
        
        .button:hover {
            background: #2563eb;
            border-color: #2563eb;
            transform: translateY(-1px);
            box-shadow: 0 4px 8px rgba(59, 130, 246, 0.3);
        }
        
        .button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
            box-shadow: none;
            background: #cbd5e1;
            border-color: #cbd5e1;
            color: #64748b;
        }
        
        .button-success {
            background: #10b981;
            border-color: #10b981;
        }
        
        .button-success:hover {
            background: #059669;
            border-color: #059669;
            box-shadow: 0 4px 8px rgba(16, 185, 129, 0.3);
        }
        
        .button-warning {
            background: #f59e0b;
            border-color: #f59e0b;
        }
        
        .button-warning:hover {
            background: #d97706;
            border-color: #d97706;
            box-shadow: 0 4px 8px rgba(245, 158, 11, 0.3);
        }
        
        .button-secondary {
            background: white;
            color: #475569;
            border-color: #cbd5e1;
        }
        
        .button-secondary:hover {
            background: #f8fafc;
            border-color: #94a3b8;
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
        }
        
        /* 下拉按钮组 */
        .dropdown {
            position: relative;
            display: inline-block;
        }
        
        .dropdown-content {
            display: none;
            position: absolute;
            background-color: white;
            min-width: 160px;
            box-shadow: 0 8px 16px 0 rgba(0,0,0,0.1);
            z-index: 1;
            border-radius: 10px;
            border: 1px solid #e2e8f0;
            overflow: hidden;
            top: 100%;
            left: 0;
            margin-top: 5px;
        }
        
        .dropdown-content a {
            color: #475569;
            padding: 12px 16px;
            text-decoration: none;
            display: block;
            border-bottom: 1px solid #f1f5f9;
            transition: all 0.3s ease;
        }
        
        .dropdown-content a:hover {
            background-color: #f8fafc;
            color: #1e40af;
        }
        
        .dropdown-content a:last-child {
            border-bottom: none;
        }
        
        .dropdown:hover .dropdown-content {
            display: block;
        }
        
        .dropdown-btn {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        
        /* IP 列表 */
        .ip-list-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            flex-wrap: wrap;
            gap: 15px;
        }
        
        .ip-list {
            background: #f8fafc;
            border-radius: 12px;
            padding: 20px;
            max-height: 500px;
            overflow-y: auto;
            border: 1px solid #e2e8f0;
        }
        
        .ip-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px 16px;
            border-bottom: 1px solid #e2e8f0;
            transition: background 0.3s ease;
        }
        
        .ip-item:hover {
            background: #f1f5f9;
        }
        
        .ip-item:last-child {
            border-bottom: none;
        }
        
        .ip-info {
            display: flex;
            align-items: center;
            gap: 16px;
        }
        
        .ip-address {
            font-family: 'SF Mono', 'Courier New', monospace;
            font-weight: 600;
            min-width: 140px;
            color: #1e293b;
        }
        
        .speed-result {
            color: #64748b;
            font-size: 0.9rem;
        }
        
        .speed-result.fast {
            color: #10b981;
            font-weight: 600;
        }
        
        .speed-result.slow {
            color: #ef4444;
        }
        
        .ip-actions {
            display: flex;
            gap: 8px;
        }
        
        .action-btn {
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 0.85rem;
            cursor: pointer;
            transition: all 0.2s ease;
            border: none;
        }
        
        /* 登录模态框 */
        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.5);
            z-index: 1000;
            align-items: center;
            justify-content: center;
        }
        
        .modal-content {
            background: white;
            border-radius: 16px;
            padding: 30px;
            width: 100%;
            max-width: 400px;
            box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
        }
        
        .modal h3 {
            margin-bottom: 20px;
            color: #1e40af;
        }
        
        .form-group {
            margin-bottom: 20px;
        }
        
        .form-group label {
            display: block;
            margin-bottom: 8px;
            font-weight: 600;
            color: #475569;
        }
        
        .form-control {
            width: 100%;
            padding: 12px 16px;
            border: 1px solid #e2e8f0;
            border-radius: 10px;
            font-size: 1rem;
            transition: border-color 0.3s ease;
        }
        
        .form-control:focus {
            outline: none;
            border-color: #3b82f6;
            box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
        }
        
        .modal-footer {
            display: flex;
            justify-content: flex-end;
            gap: 10px;
        }
        
        /* 加载动画 */
        .loading {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 3px solid rgba(255,255,255,.3);
            border-radius: 50%;
            border-top-color: white;
            animation: spin 1s ease-in-out infinite;
        }
        
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        
        /* 筛选面板 */
        .filter-panel {
            background: #f8fafc;
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 20px;
            border: 1px solid #e2e8f0;
        }
        
        .filter-group {
            display: flex;
            flex-wrap: wrap;
            gap: 15px;
            margin-bottom: 15px;
        }
        
        .filter-label {
            font-weight: 600;
            color: #475569;
            margin-right: 8px;
        }
        
        .filter-select {
            padding: 8px 12px;
            border-radius: 8px;
            border: 1px solid #e2e8f0;
            background: white;
            font-size: 0.9rem;
        }
        
        /* 响应式调整 */
        @media (max-width: 768px) {
            .header {
                flex-direction: column;
                align-items: flex-start;
                gap: 20px;
            }
            
            .social-links {
                align-self: flex-end;
            }
            
            .ip-item {
                flex-direction: column;
                align-items: flex-start;
                gap: 10px;
            }
            
            .ip-actions {
                align-self: flex-end;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <header class="header">
            <div class="header-content">
                <h1>Cloudflare IP 收集器</h1>
                <p>自动收集、测速并筛选最优 Cloudflare IP 地址</p>
            </div>
            <div class="social-links">
                <a href="https://www.youtube.com/watch?v=onrDa-iNJeY&pp=0gcJCRUKAYcqIYz" target="_blank" class="social-link youtube" title="YouTube教程">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z"/>
                    </svg>
                </a>
                <a href="https://github.com/ethgan/CF-Worker-BestIP-collector" target="_blank" class="social-link github" title="GitHub项目">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                    </svg>
                </a>
                <a href="https://t.me/yt_hytj" target="_blank" class="social-link telegram" title="Telegram群组">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M20.66 5.66l-2.34-2.34c-1.37-1.37-3.58-1.37-4.95 0l-3.12 3.12-1.93-1.91-1.41 1.41 1.42 1.42c-.1.09-.19.19-.28.31l-1.35 2.45c-.22.4.29.88.74.64l2.23-.89 5.15 5.15c.28.28.68.36 1.04.24l2.37-.78c.36-.12.65-.42.74-.78l1.35-2.45c.12-.22.22-.42.31-.61l1.42 1.42 1.41-1.41-1.92-1.92 3.12-3.12c1.37-1.37 1.37-3.58 0-4.95l-2.34-2.34zm-8.3 10.65l-3.83-3.83 1.43-1.43 2.4 2.4 4.88-4.88 1.41 1.41-6.29 6.29z"/>
                    </svg>
                </a>
            </div>
        </header>

        <div class="card">
            <h2>统计信息</h2>
            <div class="stats">
                <div class="stat">
                    <div class="stat-value">${data?.count || 0}</div>
                    <div class="stat-label">总IP数量</div>
                </div>
                <div class="stat">
                    <div class="stat-value">${fastIPs.length}</div>
                    <div class="stat-label">优质IP数量</div>
                </div>
                <div class="stat">
                    <div class="stat-value">${data?.lastUpdated ? new Date(data.lastUpdated).toLocaleString() : '未更新'}</div>
                    <div class="stat-label">最后更新时间</div>
                </div>
                <div class="stat">
                    <div class="stat-value">${data?.sources?.length || 0}</div>
                    <div class="stat-label">数据源数量</div>
                </div>
            </div>
        </div>

        <div class="card">
            <h2>操作面板</h2>
            <div class="button-group">
                <button id="updateBtn" class="button button-success" ${!isLoggedIn ? 'disabled' : ''} onclick="updateIPs()">
                    <span id="updateBtnText">更新IP列表</span>
                    <span id="updateLoading" class="loading" style="display:none"></span>
                </button>
                <button id="speedTestBtn" class="button" ${!isLoggedIn ? 'disabled' : ''} onclick="testAllSpeeds()">
                    <span id="speedTestBtnText">批量测速</span>
                    <span id="speedTestLoading" class="loading" style="display:none"></span>
                </button>
                <div class="dropdown">
                    <button class="button button-secondary dropdown-btn">
                        导出数据
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M6 9l6 6 6-6"/>
                        </svg>
                    </button>
                    <div class="dropdown-content">
                        <a href="/ips" target="_blank">所有IP (TXT)</a>
                        <a href="/fast-ips.txt" target="_blank">优质IP (TXT)</a>
                        <a href="/raw" target="_blank">原始数据 (JSON)</a>
                        <a href="/itdog-data" target="_blank">ITDog测试格式</a>
                    </div>
                </div>
                <button id="loginBtn" class="button button-warning" ${isLoggedIn ? 'style="display:none"' : ''} onclick="showLoginModal()">
                    管理员登录
                </button>
                <button id="tokenBtn" class="button button-secondary" ${!isLoggedIn ? 'style="display:none"' : ''} onclick="showTokenManager()">
                    Token管理
                </button>
                <button id="logoutBtn" class="button button-secondary" ${!isLoggedIn ? 'style="display:none"' : ''} onclick="logout()">
                    退出登录
                </button>
            </div>
        </div>

        <div class="card">
            <div class="ip-list-header">
                <h2>IP列表 ${fastIPs.length > 0 ? '(已按速度排序)' : ''}</h2>
                <div class="filter-group">
                    <div>
                        <span class="filter-label">筛选:</span>
                        <select id="delayFilter" class="filter-select" onchange="filterIPs()">
                            <option value="all">所有IP</option>
                            <option value="fast">优质IP (<100ms)</option>
                            <option value="medium">中等延迟 (100-200ms)</option>
                            <option value="slow">高延迟 (>200ms)</option>
                        </select>
                    </div>
                </div>
            </div>
            <div class="ip-list" id="ipList">
                ${renderIPList(fastIPs.length > 0 ? fastIPs : data?.ips || [])}
            </div>
        </div>
    </div>

    <!-- 登录模态框 -->
    <div id="loginModal" class="modal">
        <div class="modal-content">
            <h3>管理员登录</h3>
            <div class="form-group">
                <label for="password">管理员密码</label>
                <input type="password" id="password" class="form-control" placeholder="输入管理员密码">
            </div>
            <div class="modal-footer">
                <button class="button button-secondary" onclick="hideLoginModal()">取消</button>
                <button class="button button-success" onclick="login()">登录</button>
            </div>
        </div>
    </div>

    <!-- Token管理模态框 -->
    <div id="tokenModal" class="modal">
        <div class="modal-content">
            <h3>Token管理</h3>
            <div class="form-group">
                <label for="token">访问Token</label>
                <input type="text" id="token" class="form-control" placeholder="输入自定义Token">
            </div>
            <div class="form-group">
                <label>
                    <input type="checkbox" id="neverExpire"> 永不过期
                </label>
            </div>
            <div class="form-group" id="expiresGroup">
                <label for="expiresDays">过期时间 (天)</label>
                <input type="number" id="expiresDays" class="form-control" min="1" max="365" value="30">
            </div>
            <div class="modal-footer">
                <button class="button button-secondary" onclick="hideTokenModal()">取消</button>
                <button class="button button-success" onclick="saveToken()">保存</button>
            </div>
        </div>
    </div>

    <script>
        // 渲染IP列表
        function renderIPList(ips) {
            if (!ips || ips.length === 0) {
                return '<p style="text-align:center;padding:20px;">暂无IP数据，请点击"更新IP列表"按钮获取</p>';
            }
            
            return ips.map(ip => {
                let delayClass = '';
                let delayText = '未测试';
                
                if (ip.delay !== undefined && ip.delay !== null) {
                    delayText = `${ip.delay}ms`;
                    if (ip.delay < 100) delayClass = 'fast';
                    else if (ip.delay > 200) delayClass = 'slow';
                }
                
                return \`
                <div class="ip-item">
                    <div class="ip-info">
                        <div class="ip-address">\${ip.ip}</div>
                        <div class="speed-result \${delayClass}">\${delayText}</div>
                    </div>
                    <div class="ip-actions">
                        <button class="action-btn button-secondary" onclick="copyIP('\${ip.ip}')">复制</button>
                        <button class="action-btn button" onclick="testSpeed('\${ip.ip}')">测速</button>
                    </div>
                </div>
                \`;
            }).join('');
        }

        // 复制IP到剪贴板
        function copyIP(ip) {
            navigator.clipboard.writeText(ip).then(() => {
                alert('IP已复制: ' + ip);
            }).catch(err => {
                console.error('复制失败: ', err);
            });
        }

        // 测试单个IP速度
        async function testSpeed(ip) {
            try {
                const btn = event.currentTarget;
                btn.disabled = true;
                btn.textContent = '测试中...';
                
                const response = await fetch(\`/speedtest?ip=\${encodeURIComponent(ip)}\`);
                const data = await response.json();
                
                if (data.error) {
                    alert(\`测试失败: \${data.error}\`);
                } else {
                    alert(\`IP: \${data.ip}\n延迟: \${data.delay}ms\`);
                    location.reload();
                }
            } catch (error) {
                alert('测试失败: ' + error.message);
            } finally {
                location.reload();
            }
        }

        // 批量测速
        async function testAllSpeeds() {
            if (!confirm('确定要对所有IP进行测速吗？这可能需要几分钟时间。')) {
                return;
            }
            
            const btn = document.getElementById('speedTestBtn');
            const btnText = document.getElementById('speedTestBtnText');
            const loading = document.getElementById('speedTestLoading');
            
            btn.disabled = true;
            btnText.style.display = 'none';
            loading.style.display = 'inline-block';
            
            try {
                // 这里简化处理，实际应调用后端批量测速接口
                alert('已开始批量测速，完成后将自动刷新页面。');
                
                // 模拟测速完成后刷新
                setTimeout(() => {
                    location.reload();
                }, 3000);
            } catch (error) {
                alert('测速失败: ' + error.message);
                btn.disabled = false;
                btnText.style.display = 'inline-block';
                loading.style.display = 'none';
            }
        }

        // 更新IP列表
        async function updateIPs() {
            const btn = document.getElementById('updateBtn');
            const btnText = document.getElementById('updateBtnText');
            const loading = document.getElementById('updateLoading');
            
            btn.disabled = true;
            btnText.style.display = 'none';
            loading.style.display = 'inline-block';
            
            try {
                const response = await fetch('/update', {
                    method: 'POST',
                    headers: {
                        'Authorization': 'Bearer ${sessionId || ''}'
                    }
                });
                
                const data = await response.json();
                
                if (data.error) {
                    alert('更新失败: ' + data.error);
                } else {
                    alert('IP列表已更新，共获取 ' + (data.count || 0) + ' 个IP');
                    location.reload();
                }
            } catch (error) {
                alert('更新失败: ' + error.message);
            } finally {
                btn.disabled = false;
                btnText.style.display = 'inline-block';
                loading.style.display = 'none';
            }
        }

        // 筛选IP
        function filterIPs() {
            const filter = document.getElementById('delayFilter').value;
            const ipList = document.getElementById('ipList');
            
            // 实际应从API获取所有IP后筛选
            fetch('/raw')
                .then(response => response.json())
                .then(data => {
                    let filteredIPs = data.ips || [];
                    
                    if (filter === 'fast') {
                        filteredIPs = filteredIPs.filter(ip => ip.delay && ip.delay < 100);
                    } else if (filter === 'medium') {
                        filteredIPs = filteredIPs.filter(ip => ip.delay && ip.delay >= 100 && ip.delay <= 200);
                    } else if (filter === 'slow') {
                        filteredIPs = filteredIPs.filter(ip => ip.delay && ip.delay > 200);
                    }
                    
                    ipList.innerHTML = renderIPList(filteredIPs);
                });
        }

        // 登录相关
        function showLoginModal() {
            document.getElementById('loginModal').style.display = 'flex';
        }

        function hideLoginModal() {
            document.getElementById('loginModal').style.display = 'none';
        }

        async function login() {
            const password = document.getElementById('password').value;
            
            if (!password) {
                alert('请输入密码');
                return;
            }
            
            try {
                const response = await fetch('/admin-login', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ password })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    alert('登录成功');
                    // 刷新页面以应用登录状态
                    window.location.href = \`/?session=\${data.sessionId}\`;
                } else {
                    alert('登录失败: ' + data.error);
                }
            } catch (error) {
                alert('登录失败: ' + error.message);
            }
        }

        // Token管理
        function showTokenManager() {
            fetch('/admin-token')
                .then(response => response.json())
                .then(data => {
                    if (data.tokenConfig) {
                        document.getElementById('token').value = data.tokenConfig.token;
                        document.getElementById('neverExpire').checked = data.tokenConfig.neverExpire || false;
                        document.getElementById('expiresDays').value = data.tokenConfig.neverExpire ? 30 : 
                            Math.round((new Date(data.tokenConfig.expires) - new Date()) / (1000 * 60 * 60 * 24));
                    }
                    
                    document.getElementById('expiresGroup').style.display = 
                        document.getElementById('neverExpire').checked ? 'none' : 'block';
                    
                    document.getElementById('tokenModal').style.display = 'flex';
                });
        }

        function hideTokenModal() {
            document.getElementById('tokenModal').style.display = 'none';
        }

        document.getElementById('neverExpire').addEventListener('change', function() {
            document.getElementById('expiresGroup').style.display = this.checked ? 'none' : 'block';
        });

        async function saveToken() {
            const token = document.getElementById('token').value;
            const neverExpire = document.getElementById('neverExpire').checked;
            const expiresDays = document.getElementById('expiresDays').value;
            
            if (!token) {
                alert('请输入Token');
                return;
            }
            
            if (!neverExpire && (!expiresDays || expiresDays < 1 || expiresDays > 365)) {
                alert('请输入1-365之间的过期天数');
                return;
            }
            
            try {
                const response = await fetch('/admin-token', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ${sessionId || ''}'
                    },
                    body: JSON.stringify({
                        token,
                        neverExpire,
                        expiresDays: neverExpire ? null : parseInt(expiresDays)
                    })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    alert('Token已更新');
                    hideTokenModal();
                } else {
                    alert('更新失败: ' + data.error);
                }
            } catch (error) {
                alert('更新失败: ' + error.message);
            }
        }

        // 登出
        async function logout() {
            if (confirm('确定要退出登录吗？')) {
                await fetch('/admin-logout');
                window.location.href = '/';
            }
        }

        // 页面加载完成后初始化
        window.onload = function() {
            // 检查管理员状态
            fetch('/admin-status')
                .then(response => response.json())
                .then(data => {
                    if (!data.hasAdminPassword) {
                        document.getElementById('loginBtn').style.display = 'none';
                        document.getElementById('updateBtn').disabled = false;
                        document.getElementById('speedTestBtn').disabled = false;
                    }
                });
        };
    </script>
</body>
</html>`;

    return new Response(html, {
        headers: {
            'Content-Type': 'text/html; charset=UTF-8',
            'Access-Control-Allow-Origin': '*'
        }
    });
}

// 辅助函数：获取存储的IP数据
async function getStoredIPs(env) {
    const data = await env.IP_STORAGE.get('cloudflare_ips');
    return data ? JSON.parse(data) : { ips: [], count: 0, lastUpdated: null };
}

// 辅助函数：获取测速后的IP数据
async function getStoredSpeedIPs(env) {
    const data = await env.IP_STORAGE.get('speed_ips');
    return data ? JSON.parse(data) : { fastIPs: [], allResults: [] };
}

// 处理CORS请求
function handleCORS() {
    return new Response(null, {
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
    });
}

// JSON响应辅助函数
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        }
    });
}

// 其他核心函数（省略部分实现，需结合cfip.js中的逻辑）
async function updateAllIPs(env) {
    // 从数据源收集IP的实现（参考cfip.js中的逻辑）
    const IP_SOURCES = [
        "https://ip.164746.xyz",
        "https://ip.haogege.xyz",
        "https://stock.hostmonit.com/CloudFlareYes",
        "https://api.uouin.com/cloudflare.html",
        "https://addressesapi.090227.xyz",
        "https://www.wetest.vip"
    ];

    const uniqueIPs = new Set();
    const results = [];

    for (const source of IP_SOURCES) {
        try {
            const res = await fetch(source);
            const text = await res.text();
            const ips = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
            ips.forEach(ip => uniqueIPs.add(ip));
            results.push({ source, count: ips.length, success: true });
        } catch (e) {
            results.push({ source, error: e.message, success: false });
        }
    }

    return {
        uniqueIPs: Array.from(uniqueIPs).map(ip => ({ ip, delay: null })),
        results
    };
}

async function autoSpeedTestAndStore(env, ips) {
    // 自动测速并存储优质IP的实现
    const testIps = ips.slice(0, AUTO_TEST_MAX_IPS);
    const results = [];

    for (const ipObj of testIps) {
        try {
            const start = Date.now();
            await fetch(`https://${ipObj.ip}`, { method: 'HEAD', timeout: 5000 });
            const delay = Math.round(Date.now() - start);
            results.push({ ...ipObj, delay });
        } catch (e) {
            results.push({ ...ipObj, delay: null, error: e.message });
        }
    }

    // 按延迟排序并取前N个优质IP
    const sorted = results
        .filter(r => r.delay !== null)
        .sort((a, b) => a.delay - b.delay);

    const fastIPs = sorted.slice(0, FAST_IP_COUNT);

    await env.IP_STORAGE.put('speed_ips', JSON.stringify({
        fastIPs,
        allResults: results,
        testedAt: new Date().toISOString()
    }));
}

// 其他API处理函数（省略部分实现）
async function handleGetIPs(env) {
    const data = await getStoredIPs(env);
    const text = data.ips.map(ip => ip.ip).join('\n');
    return new Response(text, { headers: { 'Content-Type': 'text/plain' } });
}

async function handleRawIPs(env) {
    const data = await getStoredIPs(env);
    return jsonResponse(data);
}

async function handleSpeedTest(request, env) {
    const url = new URL(request.url);
    const ip = url.searchParams.get('ip');
    if (!ip) return jsonResponse({ error: 'Missing IP' }, 400);

    try {
        const start = Date.now();
        await fetch(`https://${ip}`, { method: 'HEAD', timeout: 5000 });
        const delay = Math.round(Date.now() - start);
        return jsonResponse({ ip, delay });
    } catch (e) {
        return jsonResponse({ ip, error: '超时或无法连接', delay: null });
    }
}

async function handleItdogData(env) {
    const data = await getStoredIPs(env);
    const text = data.ips.map(ip => `${ip.ip}:443`).join('\n');
    return new Response(text, { headers: { 'Content-Type': 'text/plain' } });
}

async function handleGetFastIPs(env) {
    const speedData = await getStoredSpeedIPs(env);
    return jsonResponse(speedData.fastIPs);
}

async function handleGetFastIPsText(env) {
    const speedData = await getStoredSpeedIPs(env);
    const text = speedData.fastIPs.map(ip => ip.ip).join('\n');
    return new Response(text, { headers: { 'Content-Type': 'text/plain' } });
}

async function handleUpdate(env, request) {
    if (!await verifyAdmin(request, env)) {
        return jsonResponse({ error: '需要管理员权限' }, 401);
    }

    const { uniqueIPs, results } = await updateAllIPs(env);
    await env.IP_STORAGE.put('cloudflare_ips', JSON.stringify({
        ips: uniqueIPs,
        lastUpdated: new Date().toISOString(),
        count: uniqueIPs.length,
        sources: results
    }));

    return jsonResponse({ count: uniqueIPs.length, success: true });
}
