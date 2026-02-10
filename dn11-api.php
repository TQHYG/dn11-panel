<?php
/**
 * DN11 Network API (PHP Port)
 * Target System: Linux Server with Bird2 & WireGuard
 */

// header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

header('Content-Type: application/json');

// ============================================
// Configuration
// ============================================

const WIREGUARD_DIR = "/etc/wireguard";
const BIRD_CONFIG = "/etc/bird/ebgp_peers.conf";
const MAX_HANDSHAKE_AGE = 180;
const API_SECRET = "CHANGE_ME";

// ============================================
// Security Checks
// ============================================

function check_access() {
    // 获取当前访问的域名
    $host = explode(':', $_SERVER['HTTP_HOST'] ?? '')[0];
    
    // 改为你自己的域名，匹配这些域名时允许访问 API
    if (in_array($host, ['dn11.example.com', 'dn11.example.net'])) {
        return true; 
    }

    $client_ip = $_SERVER['REMOTE_ADDR'] ?? '';
    
    // 定义局域网和本地网段
    $is_local = false;
    $local_networks = [
        '127.0.0.0/8',
        '10.0.0.0/8',
        '172.16.0.0/12',
        '192.168.0.0/16',
        '100.64.0.0/10'
    ];

    foreach ($local_networks as $cidr) {
        if (ip_in_range($client_ip, $cidr)) {
            $is_local = true;
            break;
        }
    }

    if (!$is_local) {
        header('HTTP/1.1 403 Forbidden');
        header('Content-Type: application/json');
        die(json_encode([
            'status' => 'error', 
            'message' => 'Access Denied: Unrecognized Host or Remote IP'
        ]));
    }
}

function ip_in_range($ip, $range) {
    if (strpos($range, '/') === false) $range .= '/32';
    list($range, $netmask) = explode('/', $range, 2);
    $range_decimal = ip2long($range);
    $ip_decimal = ip2long($ip);
    $wildcard_decimal = pow(2, (32 - $netmask)) - 1;
    $netmask_decimal = ~ $wildcard_decimal;
    return (($ip_decimal & $netmask_decimal) == ($range_decimal & $netmask_decimal));
}

// Perform Security Check
check_access();

// ============================================
// Helper Functions
// ============================================

function safe_exec($cmd) {
    // Escaping is handled by caller or specific logic, but we suppress stderr in output usually
    // Using sudo for privileged commands
    $output = [];
    $return_var = 0;
    exec("sudo " . $cmd . " 2>&1", $output, $return_var);
    return ['output' => implode("\n", $output), 'status' => $return_var];
}

function is_valid_ip($ip) {
    return filter_var($ip, FILTER_VALIDATE_IP);
}

function is_valid_domain($domain) {
    return (preg_match("/^([a-z\d](-*[a-z\d])*)(\.([a-z\d](-*[a-z\d])*))*$/i", $domain) 
            && preg_match("/^.{1,253}$/", $domain) 
            && preg_match("/^[^\.]{1,63}(\.[^\.]{1,63})*$/", $domain));
}

// ============================================
// API Actions
// ============================================

function get_peers_status() {
    $peers_data = [];
    $now = time();

    // 获取所有 WireGuard 配置文件
    $cmd = safe_exec("ls " . WIREGUARD_DIR);
    $all_files = explode("\n", trim($cmd['output']));
    $files = array_filter($all_files, function($f) {
        return preg_match('/^dn11-.*\.conf$/', $f);
    });
    $files = array_map(function($f) {
        return WIREGUARD_DIR . "/" . $f;
    }, $files);

    // 一次性获取 birdc 输出
    $bird_all = safe_exec("birdc show protocols")['output'];
    $bird_lines = explode("\n", trim($bird_all));

    // 读取 BIRD 配置文件
    $bird_conf = safe_exec("cat " . BIRD_CONFIG)['output'];

    foreach ($files as $file_path) {
        if (empty($file_path) || strpos($file_path, 'No such file') !== false) continue;
        
        $interface = basename($file_path, '.conf');
        
        // 提取隧道 IP
        $conf_content = safe_exec("cat " . escapeshellarg($file_path))['output'];
        $tunnel_ip = "";
        if (preg_match('/PostUp.*ip addr add.*peer\s+([0-9.\/]+)/', $conf_content, $matches)) {
            $tunnel_ip = $matches[1];
        }

        // 提取 ASN
        $asn = "";
        $asn_matches = [];
        if (preg_match("/protocol\s+bgp\s+'" . preg_quote($interface, '/') . "'[^{]*\{[^}]*?\bas\s+(\d+)\s*;/s", $bird_conf, $asn_matches)) {
            $asn = $asn_matches[1];
        }

        // WireGuard 状态检查
        $wg_check = safe_exec("wg show " . escapeshellarg($interface) . " latest-handshakes");
        $wg_status = "down";
        $wg_error = "No handshake recorded";
        $wg_handshake_ts = 0;

        $parts = preg_split('/\s+/', trim($wg_check['output']));
        if (count($parts) >= 2) {
            $wg_handshake_ts = intval($parts[1]);
        }

        if ($wg_handshake_ts > 0) {
            $diff = $now - $wg_handshake_ts;
            if ($diff < MAX_HANDSHAKE_AGE) {
                $wg_status = "up";
                $wg_error = "";
            } else {
                $wg_status = "down";
                $wg_error = "Last handshake {$diff}s ago";
            }
        }

        // Bird 状态检查
        $bird_status = "down";
        $bird_error = "Not found in BIRD";
        foreach ($bird_lines as $line) {
            if (strpos($line, $interface) === 0) {
                if (strpos($line, "Established") !== false) {
                    $bird_status = "up";
                    $bird_error = "";
                } else {
                    $clean_out = preg_replace('/\s+/', ' ', trim($line));
                    $parts = explode(' ', $clean_out);
                    $state = $parts[3] ?? 'Unknown';
                    $info = $parts[5] ?? 'Unknown';
                    $details = implode(' ', array_slice($parts, 6));
                    if (!empty($details)) {
                        $bird_error = "State: $state, Info: $info, Error: $details";
                    } else {
                        $bird_error = "State: $state, Info: $info";
                    }
                }
                break;
            }
        }

        // 总体状态和错误汇总
        $overall = "healthy";
        $err_summary = [];
        if ($wg_status === 'down') {
            $overall = "unhealthy";
            $err_summary[] = "WG: $wg_error";
        }
        if ($bird_status === 'down') {
            $overall = "unhealthy";
            $err_summary[] = "BIRD: $bird_error";
        }

        $peer_json = [
            'interface' => $interface,
            'asn' => $asn,
            'tunnel_ip' => $tunnel_ip,
            'wg_status' => $wg_status,
            'bird_status' => $bird_status,
            'overall_status' => $overall
        ];

        if (!empty($err_summary)) {
            $peer_json['error_summary'] = implode(', ', $err_summary);
        }

        $peers_data[] = $peer_json;
    }

    echo json_encode(['status' => 'success', 'data' => $peers_data]);
}


function get_routing_table() {
    $res = safe_exec("ip route show");
    $lines = explode("\n", trim($res['output']));
    // Filter empty lines
    $lines = array_values(array_filter($lines));
    echo json_encode(['status' => 'success', 'data' => $lines]);
}

function bird_show() {
    $cmd = $_GET['cmd'] ?? '';
    $param = $_GET['param'] ?? '';
    $name = $_GET['name'] ?? '';
    $target_ip = $_GET['ip'] ?? '';
    $route_all = $_GET['route_all'] ?? ''; // Added: Handle route_all flag
    
    $valid_cmds = ['protocols', 'route', 'interfaces', 'status'];
    if (!in_array($cmd, $valid_cmds)) {
        die(json_encode(['status' => 'error', 'message' => 'Invalid command']));
    }

    $bird_cmd = "show " . escapeshellcmd($cmd);

    // Handle Route Command Specifics
    if ($cmd === 'route') {
        if (!empty($target_ip)) {
            if (!is_valid_ip($target_ip) && strpos($target_ip, '/') === false) {
                die(json_encode(['status' => 'error', 'message' => 'Invalid IP']));
            }
            $bird_cmd .= " for " . escapeshellarg($target_ip);
        }
        if ($param === 'all' || $route_all === '1') $bird_cmd .= " all"; // Modified: check route_all
        if (!empty($name)) {
            if (!preg_match('/^[a-zA-Z0-9_-]+$/', $name)) die(json_encode(['status' => 'error']));
            $bird_cmd .= " protocol " . escapeshellarg($name);
        }
    } else {
        // Handle Protocols/Status
        if ($param === 'all') $bird_cmd .= " all";
        if (!empty($name) && $cmd === 'protocols') {
            if (!preg_match('/^[a-zA-Z0-9_-]+$/', $name)) die(json_encode(['status' => 'error']));
            $bird_cmd .= " \"" . escapeshellcmd($name) . "\"";
        }
    }

    $res = safe_exec("birdc " . $bird_cmd);
    
    if ($res['status'] !== 0) {
        die(json_encode(['status' => 'error', 'message' => 'Failed', 'details' => $res['output']]));
    }

    echo json_encode(['status' => 'success', 'command' => $bird_cmd, 'output' => $res['output']]);
}

// ============================================
// 以下变量需要根据你的实际网络拓扑修改
// interface / interface_srv: 连接到路由器的 WireGuard 接口名（格式: {你的昵称}-router）
// bgp_proto: BIRD 中对应的 iBGP 协议名
// cloud_ip / tunnel_ip: 服务器和路由器的内网/隧道 IP
// ============================================
function check_router_connection() {
    $cloud_ip = "172.16.80.250"; // 服务器内网 IP
    $tunnel_ip = "172.16.80.254"; // 对端路由器隧道 IP
    $interface = "name-router";     // 改为你的接口名，如 alice-router
    $interface_srv = "name-router"; // 同上
    $bgp_proto = "IBGP-router";    // 改为你 BIRD 配置中对应的 iBGP 协议名

    // 1. Check WireGuard Interface
    $wg_check = safe_exec("ip link show " . escapeshellarg($interface_srv));
    $wg_up = (strpos($wg_check['output'], "UP") !== false) ? "up" : "down";

    // 2. Check OSPF Neighbor
    // OSPF 邻居表里找对端 IP
    $ospf_check = safe_exec("birdc show ospf neighbors");
    $ospf_status = (strpos($ospf_check['output'], $tunnel_ip) !== false && strpos($ospf_check['output'], "Full") !== false) ? "up" : "down";

    // 3. Check BFD
    $bfd_check = safe_exec("birdc show bfd sessions");
    $bfd_status = (strpos($bfd_check['output'], $tunnel_ip) !== false && strpos($bfd_check['output'], "Up") !== false) ? "up" : "down";

    // 4. Check iBGP
    $bgp_check = safe_exec("birdc show protocols");
    // 简单检查 output 中是否有该协议且为 Established
    $ibgp_status = "down";
    $pattern = '/^' . preg_quote($bgp_proto, '/') . '.*Established$/m';

    if (preg_match($pattern, $bgp_check['output'])) {
        $ibgp_status = "up";
    }

    // 5. Check Kernel Route to Router
    $route_check = safe_exec("ip route show " . escapeshellarg($tunnel_ip));
    $route_status = (strpos($route_check['output'], "dev $interface_srv") !== false) ? "present" : "missing";

    $is_healthy = ($wg_up === 'up' && $ospf_status === 'up' && $ibgp_status === 'up') ? true : false;

    $data = [
        'interface' => $interface_srv,
        'healthy' => $is_healthy,
        'checks' => [
            'wireguard' => $wg_up,
            'ospf' => $ospf_status,
            'bfd' => $bfd_status,
            'ibgp' => $ibgp_status,
            'system_route' => $route_status
        ]
    ];

    echo json_encode(['status' => 'success', 'data' => $data]);
}

function execute_net_tool($tool) {
    $host = $_GET['host'] ?? '';
    
    // Validations
    $clean_host = preg_replace('/[^\w\.\-:]/', '', $host);
    if (!is_valid_ip($clean_host) && !is_valid_domain($clean_host)) {
        die(json_encode(['status' => 'error', 'message' => 'Invalid Host']));
    }

    $output = "";
    
    if ($tool === 'ping') {
        $res = safe_exec("ping -c 1 -W 2 " . escapeshellarg($clean_host) . " | grep from");
        $output = $res['output'];
    } elseif ($tool === 'tcping') {
        $port = intval($_GET['port'] ?? 80);
        if ($port < 1 || $port > 65535) die(json_encode(['status' => 'error', 'message' => 'Invalid Port']));
        
        // Check if tcping exists, otherwise use nc
        $check = safe_exec("which tcping");
        if (!empty($check['output'])) {
            $res = safe_exec("tcping --no-color -c 1 " . escapeshellarg($clean_host) . " $port | grep 'Reply from'");
        } else {
            // Fallback to nc (netcat) -z for scanning
            $res = safe_exec("nc -z -w 2 -v " . escapeshellarg($clean_host) . " $port");
        }
        $output = $res['output'];
    } elseif ($tool === 'nslookup') {
        $dns = $_GET['dns'] ?? '';
        $cmd = "host " . escapeshellarg($clean_host);
        if (!empty($dns) && is_valid_ip($dns)) {
            $cmd .= " " . escapeshellarg($dns);
        }
        $res = safe_exec($cmd);
        $output = $res['output'];
    }

    echo json_encode(['status' => 'success', 'host' => $clean_host, 'output' => $output]);
}

function handle_traceroute() {
    $host = $_GET['host'] ?? '';
    
    if (empty($host)) {
        die(json_encode(['status' => 'error', 'message' => 'Host parameter is required']));
    }
    
    // 验证并清理主机名/IP
    $clean_host = preg_replace('/[^\w\.\-:]/', '', $host);
    if (!is_valid_ip($clean_host) && !is_valid_domain($clean_host)) {
        die(json_encode(['status' => 'error', 'message' => 'Invalid IP address or domain name']));
    }
    
    // --- 关键：设置流式输出头 ---
    header('Content-Type: text/plain; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    header('X-Accel-Buffering: no'); 
    header('Cache-Control: no-cache');
    
    // 关闭所有 PHP 输出缓冲
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    ob_implicit_flush(true);
    
    $command = "sudo timeout 60 traceroute -m 129 -w 1 " . escapeshellarg($clean_host) . " 2>&1";
    
    // 使用 proc_open 执行命令并读取实时流
    $descriptorspec = array(
        0 => array("pipe", "r"), // stdin
        1 => array("pipe", "w"), // stdout
        2 => array("pipe", "w")  // stderr
    );
    
    $process = proc_open($command, $descriptorspec, $pipes);
    
    if (is_resource($process)) {
        fclose($pipes[0]);
        // 实时读取输出
        while (($line = fgets($pipes[1])) !== false) {
            echo $line;
            flush();
            ob_flush();
        }
        
        $stderr = stream_get_contents($pipes[2]);
        if (!empty(trim($stderr))) {
            echo "\nError: " . trim($stderr);
        }
        
        fclose($pipes[1]);
        fclose($pipes[2]);
        proc_close($process);
    } else {
        echo "Failed to start traceroute process";
    }
    
    exit; 
}

function get_ospf_state() {
    // 返回纯文本，不用 JSON
    header('Content-Type: text/plain; charset=utf-8');

    $res = safe_exec("birdc show ospf state");
    echo $res['output'];
    exit;
}

// ============================================
// Authentication
// ============================================

function verify_auth($params, $timestamp, $token) {
    if (empty($timestamp) || empty($token)) {
        die(json_encode(['status' => 'error', 'message' => 'Missing authentication']));
    }

    $now = time();
    if (abs($now - intval($timestamp)) > 300) {
        die(json_encode(['status' => 'error', 'message' => 'Auth token expired']));
    }

    ksort($params);
    $parts = [];
    foreach ($params as $k => $v) {
        $parts[] = "$k=$v";
    }
    $param_str = implode('&', $parts);
    $expected = hash('sha256', API_SECRET . $timestamp . $param_str);

    if (!hash_equals($expected, $token)) {
        die(json_encode(['status' => 'error', 'message' => 'Invalid auth token']));
    }
}

// ============================================
// Add Peer
// ============================================

function add_peer() {
    $input = json_decode(file_get_contents('php://input'), true);
    if (!$input) {
        die(json_encode(['status' => 'error', 'message' => 'Invalid JSON input']));
    }

    $name     = $input['name'] ?? '';
    $peer_ip  = $input['peer_ip'] ?? '';
    $pubkey   = $input['pubkey'] ?? '';
    $endpoint = $input['endpoint'] ?? '';
    $asn      = $input['asn'] ?? '';
    $timestamp = $input['timestamp'] ?? '';
    $token    = $input['token'] ?? '';

    // Verify auth
    verify_auth([
        'name' => $name,
        'peer_ip' => $peer_ip,
        'pubkey' => $pubkey,
        'endpoint' => $endpoint,
        'asn' => $asn
    ], $timestamp, $token);

    // Validate inputs
    if (!preg_match('/^[a-z0-9]{1,6}$/', $name)) {
        die(json_encode(['status' => 'error', 'message' => 'Invalid peer name']));
    }
    if (!is_valid_ip($peer_ip)) {
        die(json_encode(['status' => 'error', 'message' => 'Invalid peer IP']));
    }
    if (empty($pubkey)) {
        die(json_encode(['status' => 'error', 'message' => 'Public key required']));
    }
    if (empty($asn) || !ctype_digit($asn)) {
        die(json_encode(['status' => 'error', 'message' => 'Invalid ASN']));
    }

    // Build command
    $cmd = sprintf('dn11-peer add --batch --name %s --peer-ip %s --pubkey %s --asn %s',
        escapeshellarg($name),
        escapeshellarg($peer_ip),
        escapeshellarg($pubkey),
        escapeshellarg($asn)
    );
    if (!empty($endpoint)) {
        $cmd .= sprintf(' --endpoint %s', escapeshellarg($endpoint));
    }

    $log_file = '/tmp/dn11-add-peer-' . time() . '.log';
    $result = shell_exec("sudo $cmd 2>" . escapeshellarg($log_file));

    if (!empty(trim($result ?? ''))) {
        // Script outputs JSON directly, pass through
        echo $result;
    } else {
        $log = @file_get_contents($log_file) ?: 'No log available';
        echo json_encode(['status' => 'error', 'message' => 'Script produced no output', 'log' => $log]);
    }
}

// ============================================
// Get Peer Detail (authenticated)
// ============================================

function get_peer_detail() {
    $name = $_GET['name'] ?? '';
    $timestamp = $_GET['timestamp'] ?? '';
    $token = $_GET['token'] ?? '';

    if (!preg_match('/^[a-z0-9]{1,6}$/', $name)) {
        die(json_encode(['status' => 'error', 'message' => 'Invalid peer name']));
    }

    verify_auth(['name' => $name], $timestamp, $token);

    $interface = "dn11-{$name}";
    $wg_conf_path = WIREGUARD_DIR . "/{$interface}.conf";

    $conf_res = safe_exec("cat " . escapeshellarg($wg_conf_path));
    if ($conf_res['status'] !== 0 || strpos($conf_res['output'], 'No such file') !== false) {
        die(json_encode(['status' => 'error', 'message' => 'Peer not found']));
    }
    $conf_content = $conf_res['output'];

    // Parse WG config
    $pubkey = '';
    $endpoint = '';
    $listen_port = '';
    $mtu = '';
    $keepalive = false;
    $peer_ip = '';

    if (preg_match('/^PublicKey\s*=\s*(.+)$/m', $conf_content, $m)) $pubkey = trim($m[1]);
    if (preg_match('/^Endpoint\s*=\s*(.+)$/m', $conf_content, $m)) $endpoint = trim($m[1]);
    if (preg_match('/^ListenPort\s*=\s*(.+)$/m', $conf_content, $m)) $listen_port = trim($m[1]);
    if (preg_match('/^MTU\s*=\s*(.+)$/m', $conf_content, $m)) $mtu = trim($m[1]);
    if (preg_match('/^PersistentKeepalive\s*=\s*(\d+)/m', $conf_content, $m)) $keepalive = intval($m[1]) > 0;
    if (preg_match('/PostUp.*peer\s+([\d.]+)/', $conf_content, $m)) $peer_ip = $m[1];

    // Read ASN from BIRD config
    $asn = '';
    $bird_conf = safe_exec("cat " . BIRD_CONFIG)['output'];
    if (preg_match("/protocol\s+bgp\s+'" . preg_quote($interface, '/') . "'[^{]*\{[^}]*?\bas\s+(\d+)\s*;/s", $bird_conf, $m)) {
        $asn = $m[1];
    }

    echo json_encode([
        'status' => 'success',
        'data' => [
            'name' => $name,
            'pubkey' => $pubkey,
            'peer_ip' => $peer_ip,
            'endpoint' => $endpoint,
            'asn' => $asn,
            'listen_port' => $listen_port,
            'mtu' => $mtu,
            'keepalive' => $keepalive
        ]
    ]);
}

// ============================================
// Edit Peer (authenticated)
// ============================================

function edit_peer() {
    $input = json_decode(file_get_contents('php://input'), true);
    if (!$input) {
        die(json_encode(['status' => 'error', 'message' => 'Invalid JSON input']));
    }

    $name         = $input['name'] ?? '';
    $peer_ip      = $input['peer_ip'] ?? '';
    $pubkey       = $input['pubkey'] ?? '';
    $endpoint     = $input['endpoint'] ?? '';
    $asn          = $input['asn'] ?? '';
    $listen_port  = $input['listen_port'] ?? '';
    $mtu          = $input['mtu'] ?? '';
    $keepalive    = $input['keepalive'] ?? '';
    $timestamp    = $input['timestamp'] ?? '';
    $token        = $input['token'] ?? '';

    verify_auth([
        'name' => $name,
        'peer_ip' => $peer_ip,
        'pubkey' => $pubkey,
        'endpoint' => $endpoint,
        'asn' => $asn,
        'listen_port' => $listen_port,
        'mtu' => $mtu,
        'keepalive' => $keepalive
    ], $timestamp, $token);

    if (!preg_match('/^[a-z0-9]{1,6}$/', $name)) {
        die(json_encode(['status' => 'error', 'message' => 'Invalid peer name']));
    }

    // Build command
    $cmd = sprintf('dn11-peer edit --batch --name %s', escapeshellarg($name));
    if (!empty($peer_ip))      $cmd .= sprintf(' --peer-ip %s', escapeshellarg($peer_ip));
    if (!empty($pubkey))       $cmd .= sprintf(' --pubkey %s', escapeshellarg($pubkey));
    if (!empty($endpoint))     $cmd .= sprintf(' --endpoint %s', escapeshellarg($endpoint));
    if (!empty($asn))          $cmd .= sprintf(' --asn %s', escapeshellarg($asn));
    if (!empty($listen_port))  $cmd .= sprintf(' --listen-port %s', escapeshellarg($listen_port));
    if (!empty($mtu))          $cmd .= sprintf(' --mtu %s', escapeshellarg($mtu));
    if (!empty($keepalive))    $cmd .= sprintf(' --keepalive %s', escapeshellarg($keepalive));

    $log_file = '/tmp/dn11-edit-peer-' . time() . '.log';
    $result = shell_exec("sudo $cmd 2>" . escapeshellarg($log_file));

    if (!empty(trim($result ?? ''))) {
        echo $result;
    } else {
        $log = @file_get_contents($log_file) ?: 'No log available';
        echo json_encode(['status' => 'error', 'message' => 'Script produced no output', 'log' => $log]);
    }
}

// ============================================
// Main Dispatcher
// ============================================

$action = $_GET['action'] ?? '';

switch ($action) {
    case 'get_peers':
        get_peers_status();
        break;
    case 'get_routes':
        get_routing_table();
        break;
    case 'bird_show':
        bird_show();
        break;
    case 'check_router':
        check_router_connection();
        break;
    case 'ping':
        execute_net_tool('ping');
        break;
    case 'tcping':
        execute_net_tool('tcping');
        break;
    case 'nslookup':
        execute_net_tool('nslookup');
        break;
    case 'traceroute': 
        handle_traceroute();
        break;
    case 'ospf_state':
        get_ospf_state();
        break;
    case 'add_peer':
        add_peer();
        break;
    case 'get_peer_detail':
        get_peer_detail();
        break;
    case 'edit_peer':
        edit_peer();
        break;
    default:
        echo json_encode([
            'status' => 'error', 
            'message' => 'Invalid action',
            'valid_actions' => ['get_peers', 'get_routes', 'check_router', 'bird_show', 'ping', 'tcping', 'nslookup', 'traceroute', 'ospf_state', 'add_peer', 'get_peer_detail', 'edit_peer']
        ]);
        break;
}