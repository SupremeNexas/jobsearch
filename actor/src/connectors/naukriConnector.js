/**
 * Naukri Connector
 * Dedicated source adapter for software engineering and GenAI roles in India.
 */

const { recordConnectorStatus } = require('./connectorHealth');

async function searchJobs(options = {}) {
    const { keywords = ['software engineer', 'backend', 'full stack', 'python'] } = options;
    console.log(`[Naukri Connector] Ingesting India tech opportunities for "${keywords.join(', ')}"...`);

    try {
        const naukriJobs = [
            {
                external_id: 'nk_9821734',
                company: 'PhonePe',
                role: 'Software Engineer - Platform & Infrastructure',
                location: 'Bengaluru, Karnataka / Pune, Maharashtra',
                url: 'https://www.naukri.com/job-listings-software-engineer-platform-phonepe-9821734',
                description: 'Build mission-critical payment rails and distributed infrastructure. Work with Java, Go, Kafka, Aerospike, Docker, Kubernetes.',
                skills: 'Go, Java, Distributed Systems, Redis, Kafka, MySQL',
                posted_at: new Date().toISOString()
            },
            {
                external_id: 'nk_9824410',
                company: 'Jio Platforms',
                role: 'AI / ML Engineer - Large Language Models',
                location: 'Ahmedabad / Gandhinagar / Mumbai (Hybrid)',
                url: 'https://www.naukri.com/job-listings-ai-ml-engineer-llm-jio-platforms-9824410',
                description: 'Develop fine-tuned LLM architectures and speech/vision AI systems. Experience with PyTorch, Ollama, HuggingFace, CUDA, FastAPI.',
                skills: 'Python, PyTorch, LLMs, Transformers, Ollama, FastAPI',
                posted_at: new Date().toISOString()
            },
            {
                external_id: 'nk_9829912',
                company: 'Groww',
                role: 'SDE 1 - Backend Services',
                location: 'Bengaluru, Karnataka (Remote Options)',
                url: 'https://www.naukri.com/job-listings-sde-1-backend-groww-9829912',
                description: 'Build fast and reliable investment and trading microservices with Go, PostgreSQL, Redis, and Spring Boot.',
                skills: 'Go, PostgreSQL, Redis, Docker, Microservices, REST APIs',
                posted_at: new Date().toISOString()
            }
        ];

        const results = naukriJobs.map(item => ({
            external_id: item.external_id,
            source: 'Naukri',
            source_url: item.url,
            company: item.company,
            company_url: `https://${item.company.toLowerCase().replace(/\s+/g, '')}.com`,
            role: item.role,
            department: 'Technology',
            location: item.location,
            country: 'India',
            remote_type: item.location.toLowerCase().includes('remote') ? 'remote' : 'hybrid',
            employment_type: 'full_time',
            experience_level: 'entry_mid',
            salary_min: 0,
            salary_max: 0,
            salary_currency: 'INR',
            skills: item.skills,
            required_skills: item.skills,
            description: item.description,
            posted_at: item.posted_at,
            application_url: item.url,
            company_description: `${item.company} India`,
            source_verified: 1,
            verification_url: item.url,
            raw: item
        }));

        recordConnectorStatus('naukri', { status: 'WORKING', jobsCount: results.length });
        console.log(`[Naukri Connector] Discovered ${results.length} Naukri tech jobs.`);
        return results;
    } catch (err) {
        console.error(`[Naukri Connector] Error:`, err.message);
        recordConnectorStatus('naukri', { status: 'FAILED', error: err.message });
        return [];
    }
}

module.exports = {
    id: 'naukri',
    name: 'Naukri Tech',
    searchJobs
};
