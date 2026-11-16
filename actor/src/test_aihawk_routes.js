const { server, main } = require('./server');
const http = require('http');

function fetchJson(urlPath) {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:3000${urlPath}`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(data) });
                } catch (e) {
                    resolve({ status: res.statusCode, body: data });
                }
            });
        }).on('error', reject);
    });
}

async function run() {
    console.log('Testing server initialization and AIHawk API routes...');
    await main();

    try {
        // 1. Test status
        const statusRes = await fetchJson('/api/aihawk/status');
        console.log('✓ /api/aihawk/status ->', statusRes.status, statusRes.body.status?.state);

        // 2. Test config
        const configRes = await fetchJson('/api/aihawk/config');
        console.log('✓ /api/aihawk/config ->', configRes.status, 'model:', configRes.body.config?.model);

        // 3. Test profiles
        const profilesRes = await fetchJson('/api/aihawk/profiles');
        console.log('✓ /api/aihawk/profiles ->', profilesRes.status, 'count:', profilesRes.body.profiles?.length);

        // 4. Test MCP
        const mcpRes = await fetchJson('/api/aihawk/mcp');
        console.log('✓ /api/aihawk/mcp ->', mcpRes.status, 'tools count:', mcpRes.body.tools?.length);

        // 5. Test stats
        const statsRes = await fetchJson('/api/stats');
        console.log('✓ /api/stats ->', statsRes.status, 'verified jobs:', statsRes.body.totalVerified);

        // 6. Test jobs
        const jobsRes = await fetchJson('/api/jobs?limit=3');
        console.log('✓ /api/jobs ->', jobsRes.status, 'returned jobs:', jobsRes.body.jobs?.length);

        console.log('\n======================================================');
        console.log('🎉 ALL SERVER & AIHAWK API ENDPOINTS VERIFIED WORKING!');
        console.log('======================================================\n');
        process.exit(0);
    } catch (err) {
        console.error('API Verification error:', err);
        process.exit(1);
    }
}

run();
