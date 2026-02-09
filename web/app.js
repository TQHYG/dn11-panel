// Global Configuration
const API_NODES = {
    router: "http://172.16.80.1/cgi-bin/dn11-api",
    lan: "http://172.16.80.10/nettools.php",
    server: "http://172.16.80.250:18080/dn11-api.php"
};

// PEER_INFO — 填入你自己的信息
const PEER_INFO = {
    router: {
        label: "我的路由器",     // 改为你自己的标签
        tunnelIP: "",       // 如 172.16.80.254
        publicKey: "",      // WireGuard PublicKey
        endpoint: "",       // 如 your.domain.com（不含端口）
        asn: "",            // 如 4211110001
        note: ""
    },
    server: {
        label: "我的服务器",     // 改为你自己的标签
        tunnelIP: "",       // 如 172.16.80.253
        publicKey: "",      // WireGuard PublicKey
        endpoint: "",       // 如 us.example.com（不含端口）
        asn: "",            // 如 4211110001
        note: ""            // 可填写备注信息
    }
};

// Global State
let pingIntervalId = null;
let pingChartObj = null;
let pingStats = { sent: 0, recv: 0, fail: 0, latencies: [] };

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    loadStatus();
    loadLinkStatus();
    loadPeers();
    loadServerPeers();
    initChart();
    
    // UI Event Listeners
    document.getElementById('ping-mode').addEventListener('change', (e) => {
        document.getElementById('tcp-port-div').style.display = e.target.value === 'tcping' ? 'block' : 'none';
    });
    
    document.getElementById('route-search').addEventListener('input', (e) => {
        filterRoutes(e.target.value);
    });
});

function switchTab(tabName) {
    document.querySelectorAll('.view-section').forEach(el => el.classList.add('d-none'));
    
    const targetView = document.getElementById(`view-${tabName}`);
    if (targetView) {
        targetView.classList.remove('d-none');
    }

    document.querySelectorAll('.navbar-nav .nav-link').forEach(el => el.classList.remove('active'));
    
    if (event && event.currentTarget && event.currentTarget.classList.contains('nav-link')) {
        if (event.currentTarget.closest('.navbar-nav')) {
            event.currentTarget.classList.add('active');
        }
    } else {
        const navLinks = document.querySelectorAll('.navbar-nav .nav-link');
        navLinks.forEach(link => {
            if (link.getAttribute('onclick')?.includes(`'${tabName}'`)) {
                link.classList.add('active');
            }
        });
    }
}

// --- BGP & System Status Modules ---

async function loadStatus() {
    const container = document.getElementById('bird-status-container');
    const ifTable = document.getElementById('interfaces-table').querySelector('tbody');
    
    try {
        // 1. Get Bird Status
        const res = await fetch(`${API_NODES.router}?action=bird_show&cmd=status`);
        const data = await res.json();
        
        // Parse basic text output
        const lines = data.output.split('\n');
        const routerId = lines.find(l => l.includes('Router ID')) || 'Unknown';
        const version = lines[0] || 'Unknown';
        const uptime = lines.find(l => l.includes('Last reboot')) || '';

        container.innerHTML = `
            <div class="col-md-6">
                <div class="card text-white bg-success mb-3">
                    <div class="card-header"><i class="fa-solid fa-wifi me-1"></i> Router Status</div>
                    <div class="card-body">
                        <h5 class="card-title">${version}</h5>
                        <p class="card-text">${routerId}<br><small>${uptime}</small></p>
                    </div>
                </div>
            </div>
        `;

        // 1b. Get Server Bird Status
        try {
            const resSrv = await fetch(`${API_NODES.server}?action=bird_show&cmd=status`);
            const dataSrv = await resSrv.json();
            const srvLines = dataSrv.output.split('\n');
            const srvRouterId = srvLines.find(l => l.includes('Router ID')) || 'Unknown';
            const srvVersion = srvLines[0] || 'Unknown';
            const srvUptime = srvLines.find(l => l.includes('Last reboot')) || '';
            container.innerHTML += `
                <div class="col-md-6">
                    <div class="card text-white bg-success mb-3">
                        <div class="card-header"><i class="fa-solid fa-server me-1"></i> Server Status</div>
                        <div class="card-body">
                            <h5 class="card-title">${srvVersion}</h5>
                            <p class="card-text">${srvRouterId}<br><small>${srvUptime}</small></p>
                        </div>
                    </div>
                </div>
            `;
        } catch (e2) {
            container.innerHTML += `
                <div class="col-md-6">
                    <div class="card text-white bg-danger mb-3">
                        <div class="card-header"><i class="fa-solid fa-server me-1"></i> Server Status</div>
                        <div class="card-body">
                            <h5 class="card-title">无法连接</h5>
                            <p class="card-text">${e2.message}</p>
                        </div>
                    </div>
                </div>
            `;
        }

        // 2. Get Interfaces
        const resIf = await fetch(`${API_NODES.router}?action=bird_show&cmd=interfaces`);
        const dataIf = await resIf.json();
        const ifLines = dataIf.output.split('\n');
        
        let interfaces = [];
        let currentIf = null;
        
        // Simple text parser for interface output
        ifLines.forEach(line => {
            if (!line.startsWith('\t') && line.trim() !== '' && !line.includes('BIRD')) {
                const parts = line.split(' ');
                currentIf = {
                    name: parts[0],
                    state: parts[1],
                    mtu: '未知',
                    details: [line.trim()] 
                };
                
                const mtuMatch = line.match(/MTU[=:\s](\d+)/i);
                if (mtuMatch) {
                    currentIf.mtu = mtuMatch[1];
                }
                
                interfaces.push(currentIf);
            } else if (line.startsWith('\t') && currentIf) {
                const trimmedLine = line.trim();
                currentIf.details.push(trimmedLine);
                
                if (currentIf.mtu === '未知') {
                    const mtuMatch = line.match(/MTU[=:\s](\d+)/i);
                    if (mtuMatch) {
                        currentIf.mtu = mtuMatch[1];
                    }
                }
            } else if (line.trim() === '' && currentIf) {
                currentIf = null;
            }
        });

        let html = '';
        interfaces.forEach(iface => {
            const badge = iface.state === 'up' 
                ? '<span class="badge bg-success">UP</span>' 
                : '<span class="badge bg-danger">DOWN</span>';
            
            html += `<tr>
                <td class="fw-bold">${iface.name}</td>
                <td>${badge}</td>
                <td><span class="text-muted">${iface.mtu}</span></td>
                <td class="font-monospace small">`;
            
            // 添加所有详细信息
            iface.details.forEach(detail => {
                html += `${detail}<br>`;
            });
            
            html += `</td></tr>`;
        });

        ifTable.innerHTML = html;

        // 3. Get Server Interfaces
        try {
            const srvIfTable = document.getElementById('server-interfaces-table').querySelector('tbody');
            const resSrvIf = await fetch(`${API_NODES.server}?action=bird_show&cmd=interfaces`);
            const dataSrvIf = await resSrvIf.json();
            const srvIfLines = dataSrvIf.output.split('\n');
            
            let srvInterfaces = [];
            let srvCurrentIf = null;
            
            srvIfLines.forEach(line => {
                if (!line.startsWith('\t') && line.trim() !== '' && !line.includes('BIRD')) {
                    const parts = line.split(' ');
                    srvCurrentIf = { name: parts[0], state: parts[1], mtu: '\u672a\u77e5', details: [line.trim()] };
                    const mtuMatch = line.match(/MTU[=:\s](\d+)/i);
                    if (mtuMatch) srvCurrentIf.mtu = mtuMatch[1];
                    srvInterfaces.push(srvCurrentIf);
                } else if (line.startsWith('\t') && srvCurrentIf) {
                    srvCurrentIf.details.push(line.trim());
                    if (srvCurrentIf.mtu === '\u672a\u77e5') {
                        const mtuMatch = line.match(/MTU[=:\s](\d+)/i);
                        if (mtuMatch) srvCurrentIf.mtu = mtuMatch[1];
                    }
                } else if (line.trim() === '' && srvCurrentIf) {
                    srvCurrentIf = null;
                }
            });

            let srvHtml = '';
            srvInterfaces.forEach(iface => {
                const badge = iface.state === 'up' 
                    ? '<span class="badge bg-success">UP</span>' 
                    : '<span class="badge bg-danger">DOWN</span>';
                srvHtml += `<tr><td class="fw-bold">${iface.name}</td><td>${badge}</td><td class="text-muted">${iface.mtu}</td><td class="font-monospace small">`;
                iface.details.forEach(d => { srvHtml += `${d}<br>`; });
                srvHtml += `</td></tr>`;
            });
            srvIfTable.innerHTML = srvHtml;
        } catch (e3) {
            document.getElementById('server-interfaces-table').querySelector('tbody').innerHTML = 
                `<tr><td colspan="4" class="text-danger">无法连接服务器: ${e3.message}</td></tr>`;
        }

    } catch (e) {
        container.innerHTML = `<div class="alert alert-danger">无法连接到管理节点: ${e.message}</div>`;
    }
}

// --- Link Status between Router and Server ---
async function loadLinkStatus() {
    const container = document.getElementById('link-status-container');
    
    const checkNames = {
        wireguard: { label: 'WireGuard', icon: 'fa-shield-halved' },
        ospf: { label: 'OSPF', icon: 'fa-diagram-project' },
        bfd: { label: 'BFD', icon: 'fa-heart-pulse' },
        ibgp: { label: 'iBGP', icon: 'fa-circle-nodes' },
        system_route: { label: '\u7cfb\u7edf\u8def\u7531', icon: 'fa-route' }
    };

    let routerResult = null, serverResult = null;
    let routerErr = null, serverErr = null;

    try {
        const res = await fetch(`${API_NODES.router}?action=check_cloud`);
        routerResult = await res.json();
    } catch(e) { routerErr = e.message; }

    try {
        const res = await fetch(`${API_NODES.server}?action=check_router`);
        serverResult = await res.json();
    } catch(e) { serverErr = e.message; }

    // Determine overall health
    const routerOk = routerResult?.status === 'success' && routerResult?.data?.healthy === true;
    const serverOk = serverResult?.status === 'success' && serverResult?.data?.healthy === true;
    const allHealthy = routerOk && serverOk;

    // Collect issues from both sides
    let issues = [];
    const routerChecks = routerResult?.data?.checks || {};
    const serverChecks = serverResult?.data?.checks || {};

    Object.keys(checkNames).forEach(key => {
        const rStatus = routerChecks[key];
        const sStatus = serverChecks[key];
        if (rStatus && rStatus !== 'up' && rStatus !== 'present') {
            issues.push(`\u8def\u7531\u5668\u4fa7 ${checkNames[key].label}: ${rStatus}`);
        }
        if (sStatus && sStatus !== 'up' && sStatus !== 'present') {
            issues.push(`\u670d\u52a1\u5668\u4fa7 ${checkNames[key].label}: ${sStatus}`);
        }
    });

    if (routerErr) issues.push(`\u8def\u7531\u5668\u4fa7\u63a5\u53e3\u65e0\u6cd5\u8bbf\u95ee: ${routerErr}`);
    if (serverErr) issues.push(`\u670d\u52a1\u5668\u4fa7\u63a5\u53e3\u65e0\u6cd5\u8bbf\u95ee: ${serverErr}`);

    // Build check items HTML for both sides
    function buildCheckItems(checks, sideLabel) {
        let html = '<div class="d-flex flex-wrap gap-2 mt-1">';
        Object.keys(checkNames).forEach(key => {
            const st = checks[key];
            const ok = st === 'up' || st === 'present';
            const iconColor = ok ? 'text-success' : 'text-danger';
            const statusIcon = ok ? 'fa-circle-check' : 'fa-circle-xmark';
            const bgClass = ok ? 'bg-success-subtle' : 'bg-danger-subtle';
            html += `<span class="badge ${bgClass} text-dark fw-normal px-2 py-1"><i class="fa-solid ${checkNames[key].icon} text-muted me-1"></i>${checkNames[key].label} <i class="fa-solid ${statusIcon} ${iconColor} ms-1"></i></span>`;
        });
        html += '</div>';
        return html;
    }

    const overallIcon = allHealthy ? 'fa-link text-success' : 'fa-link-slash text-danger';
    const overallBg = allHealthy ? 'border-success' : 'border-danger';
    const overallText = allHealthy ? '\u94fe\u8def\u6b63\u5e38' : '\u94fe\u8def\u5f02\u5e38';
    const overallBadge = allHealthy 
        ? '<span class="badge bg-success"><i class="fa-solid fa-check me-1"></i>\u6b63\u5e38</span>' 
        : '<span class="badge bg-danger"><i class="fa-solid fa-xmark me-1"></i>\u5f02\u5e38</span>';

    let issueHtml = '';
    if (!allHealthy && issues.length > 0) {
        issueHtml = `<div class="mt-2">`;
        issues.forEach(i => {
            issueHtml += `<div class="text-danger small"><i class="fa-solid fa-triangle-exclamation me-1"></i>${i}</div>`;
        });
        issueHtml += `</div>`;
    }

    container.innerHTML = `
        <div class="col-12">
            <div class="card shadow-sm ${overallBg} border-start border-4">
                <div class="card-body">
                    <div class="d-flex justify-content-between align-items-center mb-2">
                        <h5 class="mb-0"><i class="fa-solid ${overallIcon} me-2"></i>${overallText}</h5>
                        ${overallBadge}
                    </div>
                    <div class="row">
                        <div class="col-md-6">
                            <div class="small text-muted mb-1"><i class="fa-solid fa-wifi me-1"></i> \u8def\u7531\u5668\u4fa7 (${routerResult?.data?.interface || 'N/A'})</div>
                            <div>${routerErr ? '<span class="text-danger">\u65e0\u6cd5\u8bbf\u95ee</span>' : buildCheckItems(routerChecks, '\u8def\u7531\u5668')}</div>
                        </div>
                        <div class="col-md-6">
                            <div class="small text-muted mb-1"><i class="fa-solid fa-server me-1"></i> \u670d\u52a1\u5668\u4fa7 (${serverResult?.data?.interface || 'N/A'})</div>
                            <div>${serverErr ? '<span class="text-danger">\u65e0\u6cd5\u8bbf\u95ee</span>' : buildCheckItems(serverChecks, '\u670d\u52a1\u5668')}</div>
                        </div>
                    </div>
                    ${issueHtml}
                </div>
            </div>
        </div>
    `;
}

async function loadPeers() {
    const container = document.getElementById('peers-container');
    container.innerHTML = '<div class="text-center"><div class="spinner-border"></div></div>';
    
    try {
        const res = await fetch(`${API_NODES.router}?action=get_peers`);
        const json = await res.json();
        
        if (json.status !== 'success') throw new Error('API Error');

        container.innerHTML = '';
        json.data.forEach(peer => {
            const isHealthy = peer.overall_status === 'healthy';
            const cardClass = isHealthy ? 'healthy' : 'down';
            const icon = isHealthy ? 'fa-check-circle text-success' : 'fa-times-circle text-danger';

            const errorSummary = peer.error_summary || '未知错误';
            const errorBtn = !isHealthy 
                ? `<button class="btn btn-outline-danger btn-sm w-100 mt-2" onclick="showPeerError('${peer.interface}', \`${errorSummary}\`)">
                    <i class="fa-solid fa-circle-info me-1"></i>查看详情
                   </button>` 
                : '';

            const card = `
                <div class="col-md-4 mb-4">
                    <div class="card shadow-sm peer-card ${cardClass} h-100">
                        <div class="card-body">
                            <div class="d-flex justify-content-between align-items-start">
                                <h5 class="card-title text-primary mb-1">${peer.interface}</h5>
                                <i class="fa-solid ${icon} fa-lg"></i>
                            </div>
                            <h6 class="card-subtitle mb-3 text-muted">ASN: ${peer.asn}</h6>
                            <ul class="list-unstyled small mb-0">
                                <li><span class="status-badge ${peer.wg_status === 'up' ? 'status-up' : 'status-down'}"></span> WireGuard: <strong>${peer.wg_status}</strong></li>
                                <li><span class="status-badge ${peer.bird_status === 'up' ? 'status-up' : 'status-down'}"></span> BIRD BGP: <strong>${peer.bird_status}</strong></li>
                                <li class="mt-2 text-secondary"><i class="fa-solid fa-network-wired"></i> ${peer.tunnel_ip}</li>
                            </ul>
                            ${errorBtn}
                        </div>
                    </div>
                </div>
            `;
            container.innerHTML += card;
        });
    } catch (e) {
        container.innerHTML = `<div class="alert alert-danger">Failed to load peers: ${e.message}</div>`;
    }
}

async function loadServerPeers() {
    const container = document.getElementById('server-peers-container');
    container.innerHTML = '<div class="text-center"><div class="spinner-border"></div></div>';
    
    try {
        const res = await fetch(`${API_NODES.server}?action=get_peers`);
        const json = await res.json();
        
        if (json.status !== 'success') throw new Error('API Error');

        container.innerHTML = '';
        json.data.forEach(peer => {
            const isHealthy = peer.overall_status === 'healthy';
            const cardClass = isHealthy ? 'healthy' : 'down';
            const icon = isHealthy ? 'fa-check-circle text-success' : 'fa-times-circle text-danger';

            const errorSummary = peer.error_summary || '\u672a\u77e5\u9519\u8bef';
            const errorBtn = !isHealthy 
                ? `<button class="btn btn-outline-danger btn-sm w-100 mt-2" onclick="showPeerError('${peer.interface}', \`${errorSummary}\`)">
                    <i class="fa-solid fa-circle-info me-1"></i>\u67e5\u770b\u8be6\u60c5
                   </button>` 
                : '';

            const card = `
                <div class="col-md-4 mb-4">
                    <div class="card shadow-sm peer-card ${cardClass} h-100">
                        <div class="card-body">
                            <div class="d-flex justify-content-between align-items-start">
                                <h5 class="card-title text-primary mb-1">${peer.interface}</h5>
                                <i class="fa-solid ${icon} fa-lg"></i>
                            </div>
                            <h6 class="card-subtitle mb-3 text-muted">ASN: ${peer.asn}</h6>
                            <ul class="list-unstyled small mb-0">
                                <li><span class="status-badge ${peer.wg_status === 'up' ? 'status-up' : 'status-down'}"></span> WireGuard: <strong>${peer.wg_status}</strong></li>
                                <li><span class="status-badge ${peer.bird_status === 'up' ? 'status-up' : 'status-down'}"></span> BIRD BGP: <strong>${peer.bird_status}</strong></li>
                                <li class="mt-2 text-secondary"><i class="fa-solid fa-network-wired"></i> ${peer.tunnel_ip}</li>
                            </ul>
                            ${errorBtn}
                        </div>
                    </div>
                </div>
            `;
            container.innerHTML += card;
        });
    } catch (e) {
        container.innerHTML = `<div class="alert alert-danger">Failed to load server peers: ${e.message}</div>`;
    }
}

function showPeerError(name, summary) {
    document.getElementById('peerErrorTitle').innerText = `节点异常: ${name}`;
    document.getElementById('peerErrorContent').innerText = summary || '暂无具体错误描述。';

    const modalElement = document.getElementById('peerErrorModal');
    const modalInstance = new bootstrap.Modal(modalElement);
    modalInstance.show();
}

async function runBirdLG() {
    const ip = document.getElementById('lg-input-ip').value.trim();
    const showAll = document.getElementById('lg-check-detail').checked;
    const container = document.getElementById('lg-results');
    const node = document.getElementById('lg-node-select').value;
    const apiBase = API_NODES[node];
    
    container.innerHTML = '正在读取 BIRD 核心数据...';

    let url = `${apiBase}?action=bird_show&cmd=route`;
    if (ip) {
        url += `&ip=${encodeURIComponent(ip)}`;
        if (showAll) url += `&route_all=1`;
    } else if (showAll) {
        url += `&param=all`;
    }

    try {
        const res = await fetch(url);
        const json = await res.json();
        if (json.status === 'error') {
            container.innerHTML = `<div class="alert alert-warning"><i class="fa-solid fa-triangle-exclamation me-2"></i><strong>查询失败:</strong> ${json.message || '未知错误'}${json.details ? '<br><code>' + json.details + '</code>' : ''}</div>`;
            return;
        }
        renderBirdLG(json.output, container);
    } catch (e) {
        container.innerHTML = `<div class="alert alert-danger">查询失败: ${e.message}</div>`;
    }
}

async function loadRoutes() {
    const tbody = document.getElementById('routes-tbody');
    tbody.innerHTML = '<tr><td colspan="5" class="text-center">加载路由表中...</td></tr>';
    
    const node = document.getElementById('route-node-select').value;
    const apiBase = API_NODES[node];
    try {
        const res = await fetch(`${apiBase}?action=get_routes`);
        const json = await res.json();
        
        let rows = '';
        json.data.forEach(line => {
            // Parser for "10.28.0.0/24 via 172.16.19.254 dev dn11-syx proto bird ..."
            const parts = line.split(' ');
            let dest = parts[0];
            let gateway = '-';
            let dev = '-';
            let proto = '-';
            let extra = '';

            for(let i=1; i<parts.length; i++) {
                if(parts[i] === 'via') gateway = parts[i+1];
                if(parts[i] === 'dev') dev = parts[i+1];
                if(parts[i] === 'proto') proto = parts[i+1];
            }
            
            // Reconstruct "Other params"
            extra = line.replace(dest, '').replace('via '+gateway, '').replace('dev '+dev, '').replace('proto '+proto, '').trim();

            rows += `<tr>
                <td class="fw-bold text-primary">${dest}</td>
                <td>${gateway}</td>
                <td><span class="badge bg-secondary">${dev}</span></td>
                <td><span class="badge bg-info text-dark">${proto}</span></td>
                <td class="text-muted small">${extra}</td>
            </tr>`;
        });
        tbody.innerHTML = rows;
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-danger">Error: ${e.message}</td></tr>`;
    }
}

function filterRoutes(query) {
    const rows = document.querySelectorAll('#routes-tbody tr');
    rows.forEach(row => {
        const text = row.innerText.toLowerCase();
        row.style.display = text.includes(query.toLowerCase()) ? '' : 'none';
    });
}

// --- Ping / TCPing Tools ---

function initChart() {
    const ctx = document.getElementById('pingChart').getContext('2d');
    pingChartObj = new Chart(ctx, {
        type: 'line',
        data: {
            labels: Array(10).fill(''),
            datasets: [{
                label: '延迟 (ms)',
                data: Array(10).fill(null),
                borderColor: '#0d6efd',
                tension: 0.3,
                fill: true,
                backgroundColor: 'rgba(13, 110, 253, 0.1)'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            scales: { y: { beginAtZero: true } }
        }
    });
}

function togglePing() {
    const btn = document.getElementById('btn-start-ping');
    if (pingIntervalId) {
        // Stop
        clearInterval(pingIntervalId);
        pingIntervalId = null;
        btn.innerHTML = '<i class="fa-solid fa-play"></i> 开始';
        btn.classList.replace('btn-danger', 'btn-success');
    } else {
        // Start
        const host = document.getElementById('ping-host').value;
        if(!host) return alert('请输入目标主机');
        
        // Reset Stats
        pingStats = { sent: 0, recv: 0, fail: 0, latencies: [] };
        updateStatsUI();
        document.getElementById('ping-log').innerHTML = '';
        
        btn.innerHTML = '<i class="fa-solid fa-stop"></i> 停止';
        btn.classList.replace('btn-success', 'btn-danger');
        
        const interval = parseInt(document.getElementById('ping-interval').value) || 1000;
        doPing(); // First run immediately
        pingIntervalId = setInterval(doPing, interval);
    }
}

async function doPing() {
    const backend = document.getElementById('ping-backend').value;
    const mode = document.getElementById('ping-mode').value;
    const host = document.getElementById('ping-host').value;
    const port = document.getElementById('ping-port').value;
    
    let url = `${backend}?action=${mode}&host=${host}`;
    if(mode === 'tcping') url += `&port=${port}`;

    pingStats.sent++;
    updateStatsUI();
    
    const logBox = document.getElementById('ping-log');
    
    try {
        const startT = performance.now();
        const res = await fetch(url);
        const json = await res.json();
        
        // Parse latency from output string since API doesn't give raw number always
        // Example: "time=47.315 ms" or "time=0.33 ms"
        // When ping/tcping fails, the backend returns empty output — treat as packet loss
        const output = (json.output || '').trim();
        const timeMatch = output.match(/time=([\d\.]+)/);
        
        if (timeMatch) {
            // Successfully got a latency value — count as received
            const latency = parseFloat(timeMatch[1]);
            pingStats.recv++;
            pingStats.latencies.push(latency);
            updateChart(latency);
            
            const line = document.createElement('div');
            line.textContent = `[#${pingStats.sent}] ${output}`;
            logBox.prepend(line);
        } else {
            // No latency extracted — target unreachable, count as packet loss
            pingStats.fail++;
            updateChart(null);
            
            const line = document.createElement('div');
            line.classList.add('text-warning');
            line.textContent = `[#${pingStats.sent}] 目标不可达: ${output || '(无响应)'}`;
            logBox.prepend(line);
        }

    } catch (e) {
        pingStats.fail++;
        const line = document.createElement('div');
        line.classList.add('text-danger');
        line.textContent = `[#${pingStats.sent}] 请求失败: ${e.message}`;
        logBox.prepend(line);
        updateChart(null); // Gap in chart
    }
    updateStatsUI();
}

function updateStatsUI() {
    document.getElementById('stat-sent').innerText = pingStats.sent;
    document.getElementById('stat-recv').innerText = pingStats.recv;
    document.getElementById('stat-fail').innerText = pingStats.fail;
    
    const loss = pingStats.sent === 0 ? 0 : (pingStats.fail / pingStats.sent * 100).toFixed(1);
    document.getElementById('stat-loss').innerText = `${loss}%`;
    
    if (pingStats.latencies.length === 0) {
        document.getElementById('stat-avg').innerText = '--- ms';
    } else {
        const totalLat = pingStats.latencies.reduce((a, b) => a + b, 0);
        const avg = (totalLat / pingStats.latencies.length).toFixed(2);
        document.getElementById('stat-avg').innerText = `${avg} ms`;
    }
}

function updateChart(latency) {
    const data = pingChartObj.data.datasets[0].data;
    data.shift();
    data.push(latency);
    pingChartObj.update();
}

// --- Traceroute (Streaming) ---

async function startTrace() {
    const host = document.getElementById('trace-host').value;
    if(!host) return alert('请输入目标主机');
    
    const btn = document.getElementById('btn-trace');
    const loading = document.getElementById('trace-loading');
    const tableBody = document.querySelector('#trace-table tbody');
    const rawBox = document.getElementById('trace-raw');
    
    // UI Reset
    btn.disabled = true;
    loading.classList.remove('d-none');
    tableBody.innerHTML = '';
    rawBox.classList.add('d-none');
    rawBox.textContent = '';
    
    const backend = document.getElementById('trace-backend').value;
    const url = `${backend}?action=traceroute&host=${host}`;
    
    try {
        const response = await fetch(url);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        
        let partialLine = '';
        
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value, { stream: true });
            const lines = (partialLine + chunk).split('\n');
            partialLine = lines.pop(); // Keep incomplete line for next chunk
            
            lines.forEach(line => {
                if(line.trim() === '') return;
                rawBox.textContent += line + '\n';
                parseTraceLine(line, tableBody);
            });
        }
        
        // Handle final line
        if (partialLine.trim()) {
            rawBox.textContent += partialLine;
            parseTraceLine(partialLine, tableBody);
        }

    } catch (e) {
        rawBox.classList.remove('d-none');
        rawBox.textContent += `\nError: ${e.message}`;
    } finally {
        btn.disabled = false;
        loading.classList.add('d-none');
    }
}

function parseTraceLine(line, tbody) {
    // Skip header
    if(line.startsWith('traceroute to')) return;
    
    // Regex to find hop number and times
    // Format: 1  gateway (192.168.1.1)  0.604 ms  0.530 ms  0.460 ms
    // Or: 8  * * *
    
    const hopMatch = line.match(/^\s*(\d+)\s+/);
    if (!hopMatch) return; // Not a standard line
    
    const hopNum = hopMatch[1];
    
    // Extract IP/Hosts (Rough extraction)
    // We look for anything that looks like an IP in parens or standard hostname
    const ipMatch = line.match(/\(([\d\.]+)\)/);
    const ip = ipMatch ? ipMatch[1] : '*';
    
    // Extract times (ms)
    const times = line.match(/([\d\.]+) ms/g);
    
    let host = 'Unknown / Timeout';
    // Try to get hostname before the IP parens
    const parts = line.split(/\s+/);
    if(parts.length > 2 && parts[2].startsWith('(')) {
        host = parts[1];
    } else if (ip !== '*') {
        host = ip;
    } else if (line.includes('* * *')) {
        host = "Request Timed Out";
    }

    const row = document.createElement('tr');
    
    let timeCells = '';
    if(times) {
        times.forEach(t => {
            const ms = parseFloat(t);
            let colorClass = 'text-success';
            if(ms > 100) colorClass = 'text-warning';
            if(ms > 200) colorClass = 'text-danger';
            timeCells += `<td class="${colorClass}">${t}</td>`;
        });
    } else {
        timeCells = '<td colspan="3" class="text-muted">* * *</td>';
    }
    
    // Filler for less than 3 probes
    if(times && times.length < 3) {
        for(let i=0; i < (3 - times.length); i++) timeCells += '<td>-</td>';
    }

    row.innerHTML = `
        <td><div class="hop-circle">${hopNum}</div></td>
        <td class="fw-bold">${host} <br> <small class="text-muted fw-normal">${ip !== '*' ? ip : ''}</small></td>
        ${timeCells}
    `;
    tbody.appendChild(row);
}

// --- NSLookup ---
async function doNslookup() {
    const host = document.getElementById('dns-host').value;
    const server = document.getElementById('dns-server').value;
    const resultDiv = document.getElementById('dns-result');
    
    if(!host) return;
    
    resultDiv.innerHTML = '<div class="spinner-border spinner-border-sm"></div> 查询中...';

    const backend = document.getElementById('dns-backend').value;
    let url = `${backend}?action=nslookup&host=${host}`;
    if(server) url += `&dns=${server}`;
    
    try {
        const res = await fetch(url);
        const json = await res.json();
        
        resultDiv.innerHTML = `
            <div class="card bg-dark text-light">
                <div class="card-header border-secondary">
                    查询结果: ${host} ${server ? `(@${server})` : ''}
                </div>
                <div class="card-body font-monospace" style="white-space: pre-wrap;">${json.output}</div>
            </div>
        `;
    } catch (e) {
        resultDiv.innerHTML = `<div class="alert alert-danger">查询失败: ${e.message}</div>`;
    }
}

// --- Bird LG ---
function renderBirdLG(text, container) {
    const lines = text.split('\n');
    let html = '';
    let currentPrefix = '';
    let entry = null;

    // 正则匹配 BIRD 路由行
    // 支持 BGP: unicast [...] * (100) [AS...]
    // 支持 OSPF: unicast [...] * E2 (150/20/10000) [x.x.x.x]  或  * I (150/20) [x.x.x.x]
    const routeRegex = /^\s*([\w.\/]+)?\s*(unicast|multicast|blackhole)?\s*\[([\w.-]+)\s+([^\]]+)\]\s*(\*)?\s*(?:[A-Z]\d?\s+)?\(([^)]+)\)\s*(?:\[(.*)\])?/;

    lines.forEach(line => {
        const m = line.match(routeRegex);
        if (m) {
            if (entry) html += buildBirdCard(entry);
            
            // 更新currentPrefix
            if (m[1] && m[1].trim() && 
                !['unicast', 'multicast', 'blackhole'].includes(m[1].trim())) {
                currentPrefix = m[1].trim();
            }
            
            entry = {
                prefix: currentPrefix,
                type: m[2] || 'unicast',
                protocol: m[3],
                time: m[4],
                isBest: m[5] === '*',
                pref: m[6],
                asnInfo: m[7] || '', 
                attrs: []
            };
        } else if (entry && line.startsWith('\t')) {
            entry.attrs.push(line.trim());
        } else {
            if (!line.startsWith(' ') && !line.startsWith('\t')) {
                const parts = line.trim().split(/\s+/);
                if (parts[0].includes('/') || parts[0].includes('.')) {
                    currentPrefix = parts[0];
                }
            }
        }
    });
    if (entry) html += buildBirdCard(entry);
    container.innerHTML = html;
}

function buildBirdCard(e) {
    let attrHtml = '';
    e.attrs.forEach(a => {
        let [key, ...valParts] = a.split(':');
        let val = valParts.join(':').trim();

        // [解析] Large Communities
        if (key.includes('community')) {
            const communities = val.match(/\(\d+,\s*\d+,\s*\d+\)/g);
            if (communities) {
                val = communities.map(c => {
                    const clean = c.replace(/[()]/g, '');
                    return `<span class="badge bg-info-subtle text-info-emphasis border border-info-subtle me-1 mb-1 font-monospace" style="font-size: 0.75rem;">
                                <i class="fa-solid fa-tag small me-1"></i>${clean}
                            </span>`;
                }).join('');
            }
        }
        // [解析] AS Path
        if (key.includes('as_path')) {
            val = `<span class="text-primary fw-bold">${val}</span>`;
        }

        attrHtml += `<div class="d-flex justify-content-between border-bottom border-light small py-1">
            <span class="text-muted">${key}</span>
            <span class="text-end">${val || a}</span>
        </div>`;
    });

    const typeBadgeColor = {
        'unicast': 'bg-primary',
        'multicast': 'bg-warning text-dark',
        'blackhole': 'bg-dark',
        'unreachable': 'bg-danger',
        'prohibit': 'bg-secondary'
    };

    const typeClass = typeBadgeColor[e.type] || 'bg-secondary';

    return `
    <div class="card mb-3 border-start ${e.isBest ? 'border-success border-4' : ''}">
        <div class="card-body p-3">
            <div class="d-flex justify-content-between align-items-start mb-2">
                <div>
                    <h5 class="font-monospace mb-0 d-inline-block">${e.prefix}</h5>
                    <span class="badge ${typeClass} ms-2">${e.type.toUpperCase()}</span>
                </div>
                <span class="badge ${e.isBest ? 'bg-success' : 'bg-light text-muted border'}">${e.isBest ? 'BEST' : 'BACKUP'}</span>
            </div>
            <div class="row g-0 mb-2 small bg-light p-1 text-center">
                <div class="col-4">通过: ${e.protocol}</div>
                <div class="col-4 border-start">Pref: ${e.pref}</div>
                <div class="col-4 border-start">${e.asnInfo}</div>
            </div>
            <div class="attrs-box">${attrHtml}</div>
        </div>
    </div>`;
}

// ============================================================
// --- 工具函数 ---
// ============================================================

// 去除 ANSI 终端颜色/转义码
function stripAnsi(str) {
    return str.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '').replace(/\[\d+;?\d*m/g, '');
}

// ============================================================
// --- 添加 Peer 功能 ---
// ============================================================

let addPeerTarget = 'server'; // 'server' or 'router'

function showAddPeerModal(target) {
    addPeerTarget = target;
    const isRouter = target === 'router';
    document.getElementById('addPeerModalTitle').textContent = isRouter
        ? '添加 Peer — 路由器' : '添加 Peer — 服务器';
    document.getElementById('add-peer-endpoint-hint').textContent = isRouter
        ? '路由器位于 NAT 后，必须填写对端 Endpoint'
        : '留空表示对端位于 NAT 后（将启用 PersistentKeepalive）';

    // Clear previous inputs and validation states
    ['name', 'ip', 'pubkey', 'endpoint', 'asn', 'password'].forEach(f => {
        const el = document.getElementById(`add-peer-${f}`);
        if (el) { el.value = ''; el.classList.remove('is-invalid', 'is-valid'); }
    });
    document.getElementById('add-peer-result').innerHTML = '';
    document.getElementById('btn-add-peer').disabled = false;
    document.getElementById('btn-add-peer').innerHTML = '<i class="fa-solid fa-plus me-1"></i>添加';

    new bootstrap.Modal(document.getElementById('addPeerModal')).show();
}

// --- Validation helpers ---

function validatePeerName(v) { return /^[a-z0-9]{1,6}$/.test(v); }

function validateIPv4(v) {
    return /^((25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)$/.test(v);
}

function validatePubkey(v) {
    // WireGuard key: 32 bytes base64 = 43 base64 chars + '='
    return /^[A-Za-z0-9+/]{43}=$/.test(v);
}

function validateASN(v) {
    return /^\d{1,10}$/.test(v) && parseInt(v) > 0;
}

function validateEndpoint(v) {
    if (!v) return true; // empty is OK for server target
    // host:port or [ipv6]:port
    return /^[\w.\-]+:\d{1,5}$/.test(v) || /^\[[\da-fA-F:]+\]:\d{1,5}$/.test(v);
}

// --- SHA-256 auth token computation ---

function computeAuthToken(password, timestamp, params) {
    const keys = Object.keys(params).sort();
    const paramStr = keys.map(k => `${k}=${params[k]}`).join('&');
    const data = password + timestamp + paramStr;
    // Uses js-sha256 library (loaded via CDN, works in non-secure HTTP contexts)
    return sha256(data);
}

// --- Submit add peer ---

async function submitAddPeer() {
    const name     = document.getElementById('add-peer-name').value.trim();
    const peer_ip  = document.getElementById('add-peer-ip').value.trim();
    const pubkey   = document.getElementById('add-peer-pubkey').value.trim();
    const endpoint = document.getElementById('add-peer-endpoint').value.trim();
    const asn      = document.getElementById('add-peer-asn').value.trim();
    const password = document.getElementById('add-peer-password').value;

    const resultDiv = document.getElementById('add-peer-result');
    let valid = true;

    function check(fieldSuffix, isValid, message) {
        const el = document.getElementById(`add-peer-${fieldSuffix}`);
        const fb = document.getElementById(`add-peer-${fieldSuffix}-fb`);
        if (isValid) {
            el.classList.remove('is-invalid');
            el.classList.add('is-valid');
        } else {
            el.classList.remove('is-valid');
            el.classList.add('is-invalid');
            if (fb) fb.textContent = message;
            valid = false;
        }
    }

    check('name',    validatePeerName(name),   '仅允许1-6位小写字母或数字');
    check('ip',      validateIPv4(peer_ip),    '请输入有效的IPv4地址');
    check('pubkey',  validatePubkey(pubkey),   '请输入有效的WireGuard公钥 (44字符Base64, 以=结尾)');
    check('asn',     validateASN(asn),         '请输入有效的ASN号 (纯数字)');

    if (addPeerTarget === 'router' && !endpoint) {
        check('endpoint', false, '路由器位于NAT后, Endpoint必填');
    } else if (endpoint && !validateEndpoint(endpoint)) {
        check('endpoint', false, '格式: host:port 或 [ipv6]:port');
    } else {
        check('endpoint', true, '');
    }

    if (!password) {
        check('password', false, 'API密码不能为空');
    } else {
        check('password', true, '');
    }

    if (!valid) return;

    // Compute auth token
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const params = { name, peer_ip, pubkey, endpoint, asn };
    const token = computeAuthToken(password, timestamp, params);

    // UI: disable button, show spinner
    const btn = document.getElementById('btn-add-peer');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>添加中...';
    resultDiv.innerHTML = '';

    const apiUrl = API_NODES[addPeerTarget];

    try {
        const res = await fetch(`${apiUrl}?action=add_peer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, peer_ip, pubkey, endpoint, asn, timestamp, token })
        });

        const json = await res.json();

        if (json.status === 'success') {
            resultDiv.innerHTML = `<div class="alert alert-success mb-0">
                <i class="fa-solid fa-check-circle me-1"></i>${json.message || 'Peer 添加成功！'}
                ${json.data ? '<br><small class="text-muted">接口: ' + json.data.interface + ', 端口: ' + json.data.listen_port + '/udp</small>' : ''}
            </div>`;
            // Refresh peer list after success
            if (addPeerTarget === 'router') loadPeers(); else loadServerPeers();
        } else {
            let detail = stripAnsi(json.message || '未知错误');
            if (json.log) detail += `<pre class="mt-2 mb-0 small bg-dark text-light p-2 rounded" style="max-height:200px;overflow:auto;">${stripAnsi(json.log)}</pre>`;
            resultDiv.innerHTML = `<div class="alert alert-danger mb-0"><i class="fa-solid fa-circle-xmark me-1"></i>${detail}</div>`;
        }
    } catch (e) {
        resultDiv.innerHTML = `<div class="alert alert-danger mb-0"><i class="fa-solid fa-circle-xmark me-1"></i>请求失败: ${e.message}</div>`;
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-plus me-1"></i>添加';
    }
}

// ============================================================
// --- Peer Info 弹窗 ---
// ============================================================

function showPeerInfo(target) {
    const info = PEER_INFO[target];
    if (!info) return;

    document.getElementById('peerInfoTitle').textContent = `Peer 信息 — ${info.label}`;

    let html = `
        <table class="table table-bordered table-sm mb-0">
            <tbody>
                <tr><th style="width:130px">隧道 IP</th><td class="font-monospace">${info.tunnelIP || '<span class="text-muted">未配置</span>'}</td></tr>
                <tr><th>PublicKey</th><td class="font-monospace" style="word-break:break-all;">${info.publicKey || '<span class="text-muted">未配置</span>'}</td></tr>
                ${info.endpoint ? `<tr><th>Endpoint</th><td class="font-monospace">${info.endpoint}:<span class="text-warning">请联系管理员获取端口</span></td></tr>` : ''}
                <tr><th>ASN</th><td class="font-monospace">${info.asn || '<span class="text-muted">未配置</span>'}</td></tr>
            </tbody>
        </table>
    `;

    if (info.note) {
        html += `<div class="alert alert-warning mt-3 mb-0 small"><i class="fa-solid fa-triangle-exclamation me-1"></i>${info.note}</div>`;
    }

    document.getElementById('peerInfoContent').innerHTML = html;
    new bootstrap.Modal(document.getElementById('peerInfoModal')).show();
}