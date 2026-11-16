const dotenv = require('dotenv');
const path = require('path');
const fetch = globalThis.fetch;

dotenv.config({ path: path.join(__dirname, '../.env') });

const url = process.env.OMNIROUTE_URL || 'http://localhost:20128/v1';
const apiKey = process.env.OMNIROUTE_API_KEY || 'sk-2cdc8d524108d19a-0abc42-d8f4f651';

const modelsToTest = [
    'claude-opus',
    'github/claude-sonnet-5',
    'github/claude-3.5-sonnet',
    'github/claude-sonnet-4.6',
    'antigravity/claude-sonnet-4-6-low',
    'antigravity/claude-sonnet-4-6',
    'no-think/antigravity/claude-sonnet-4-6-low',
    'auto/claude-sonnet'
];

async function testModel(modelName) {
    try {
        const response = await fetch(`${url}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: modelName,
                messages: [{ role: 'user', content: 'Say OK' }],
                temperature: 0.1
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, status: response.status, error: errorText };
        }

        const data = await response.json();
        return { success: true, text: data.choices[0].message.content.trim() };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function runTests() {
    console.log('Testing models against OmniRoute endpoint...\n');
    for (const model of modelsToTest) {
        console.log(`Testing model: "${model}"...`);
        const res = await testModel(model);
        if (res.success) {
            console.log(`  ✅ SUCCESS! Response: "${res.text}"`);
        } else {
            console.log(`  ❌ FAILED: Status ${res.status || 'N/A'}, Error: ${res.error}`);
        }
    }
}

runTests();
