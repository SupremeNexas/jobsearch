/**
 * Sends a notification of the application status to a Slack Webhook.
 * @param {string} webhookUrl Slack webhook URL
 * @param {object} application Details of the application
 * @param {string} screenshotUrl URL where verification screenshot is uploaded.
 */
async function sendNotification(webhookUrl, application, screenshotUrl = '') {
    if (!webhookUrl) {
        console.log('No Slack notification webhook set. Skipping notification.');
        return;
    }

    console.log(`Sending application status alert to Slack: ${application.company} - ${application.title}...`);

    let statusEmoji = application.success ? '✅' : '❌';
    if (application.success && application.message.includes('autofilled')) {
        statusEmoji = '📝'; // filled draft
    }

    const payload = {
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `${statusEmoji} *Job Application Status: ${application.company}*`
                }
            },
            {
                type: 'section',
                fields: [
                    {
                        type: 'mrkdwn',
                        text: `*Role:* ${application.title}`
                    },
                    {
                        type: 'mrkdwn',
                        text: `*Platform:* ${application.platform}`
                    },
                    {
                        type: 'mrkdwn',
                        text: `*Job URL:* <${application.url}|Link>`
                    },
                    {
                        type: 'mrkdwn',
                        text: `*Result:* ${application.message}`
                    }
                ]
            }
        ]
    };

    if (screenshotUrl) {
        payload.blocks.push({
            type: 'image',
            image_url: screenshotUrl,
            alt_text: 'Autofill Form Verification Layout'
        });
    }

    try {
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            console.error('Failed to post status to Slack Webhook:', response.statusText);
        }
    } catch (e) {
        console.error('Slack Webhook delivery crashed:', e.message);
    }
}

module.exports = { sendNotification };
