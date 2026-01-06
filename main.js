const Apify = require('apify');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const { utils: { log } } = Apify;

// Path to the sessions directory
// Use Apify's storage directory or fallback to a local directory
const getSessionsDir = () => {
    try {
        const env = Apify.getEnv();
        // Use storage directory if available, otherwise use current working directory
        if (env && env.defaultDatasetPath) {
            // Sessions should be stored in a persistent location
            // Use the storage directory structure
            const storageDir = path.dirname(path.dirname(env.defaultDatasetPath));
            return path.join(storageDir, 'sessions');
        }
    } catch (e) {
        log.warning('Could not get Apify environment, using fallback path', e);
    }
    // Fallback: use current working directory or /tmp for sessions
    return path.join(process.cwd(), 'sessions');
};
const SESSIONS_DIR = getSessionsDir();

// Ensure the sessions directory exists
if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// In-memory store for WhatsApp clients and their statuses
const sessions = new Map();

/**
 * Initializes or retrieves a WhatsApp client for a given session ID.
 * @param {string} sessionId - The unique identifier for the session.
 * @returns {Object} The session object with client and status.
 */
const initializeClient = (sessionId) => {
    if (sessions.has(sessionId) && sessions.get(sessionId).client) {
        return sessions.get(sessionId);
    }

    log.info(`Initializing WhatsApp client for session: ${sessionId}`);
    const sessionDataPath = path.join(SESSIONS_DIR, `session-${sessionId}`);

    const client = new Client({
        authStrategy: new LocalAuth({ dataPath: sessionDataPath }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        }
    });

    const session = {
        id: sessionId,
        client: client,
        qrCode: null,
        status: 'Initializing'
    };
    sessions.set(sessionId, session);

    client.on('qr', (qr) => {
        log.info(`QR code received for session: ${sessionId}`);
        session.qrCode = qr;
        session.status = 'QR Code Generated';
    });

    client.on('ready', () => {
        log.info(`WhatsApp client is ready for session: ${sessionId}`);
        session.qrCode = null;
        session.status = 'Connected';
    });

    client.on('authenticated', () => {
        log.info(`Authentication successful for session: ${sessionId}`);
        session.status = 'Connected';
    });

    client.on('auth_failure', (msg) => {
        log.error(`Authentication failure for session ${sessionId}:`, msg);
        session.status = 'Authentication Failure';
        // Clean up and remove the failed session
        if (fs.existsSync(sessionDataPath)) {
            fs.rmSync(sessionDataPath, { recursive: true, force: true });
        }
        sessions.delete(sessionId);
    });

    client.on('disconnected', (reason) => {
        log.info(`Client for session ${sessionId} was logged out:`, reason);
        session.status = 'Disconnected';
        client.destroy().catch(err => log.error(`Error destroying client for session ${sessionId}:`, err));
        sessions.delete(sessionId);
    });

    client.initialize().catch(err => {
        log.error(`Failed to initialize client for session ${sessionId}:`, err);
        sessions.delete(sessionId);
    });

    return session;
};

/**
 * Waits for a session to be connected.
 * @param {string} sessionId - The session ID.
 * @param {number} timeout - Maximum time to wait in milliseconds.
 * @returns {Promise<boolean>} True if connected, false if timeout.
 */
const waitForConnection = async (sessionId, timeout = 60000) => {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        const session = sessions.get(sessionId);
        if (session && session.status === 'Connected') {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return false;
};

/**
 * Sends a text message from a specific session.
 * @param {string} sessionId - The session ID.
 * @param {string} to - The recipient's phone number.
 * @param {string} message - The message to send.
 */
const sendMessage = async (sessionId, to, message) => {
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'Connected') {
        throw new Error(`Session ${sessionId} is not connected. Current status: ${session?.status || 'Not found'}`);
    }
    const chatId = `${to.replace(/[^0-9]/g, '')}@c.us`;
    await session.client.sendMessage(chatId, message);
    log.info(`Message sent to ${to} from session ${sessionId}`);
};

/**
 * Sends an attachment from a specific session.
 * @param {string} sessionId - The session ID.
 * @param {string} to - The recipient's phone number.
 * @param {string} file - URL to the file, local file path, or Base64 string.
 * @param {string} caption - The caption for the attachment.
 * @param {string} [type] - The MIME type, required for Base64 encoded files.
 */
const sendAttachment = async (sessionId, to, file, caption, type) => {
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'Connected') {
        throw new Error(`Session ${sessionId} is not connected. Current status: ${session?.status || 'Not found'}`);
    }

    let media;
    if (fs.existsSync(file)) {
        // Send from a local file path
        media = MessageMedia.fromFilePath(file);
    } else if (file.startsWith('http')) {
        // Send from a URL
        media = await MessageMedia.fromUrl(file, { unsafeMime: true });
    } else {
        // Send from a Base64 string
        if (!type) {
            throw new Error('The "type" parameter is required for Base64 attachments.');
        }
        const base64Data = file.includes(',') ? file.split(',')[1] : file;
        media = new MessageMedia(type, base64Data, 'file');
    }

    const chatId = `${to.replace(/[^0-9]/g, '')}@c.us`;
    await session.client.sendMessage(chatId, media, { caption });
    log.info(`Attachment sent to ${to} from session ${sessionId}`);
};

/**
 * Sleep/delay function
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

Apify.main(async () => {
    const input = await Apify.getInput();
    const { MASTER_API_KEY } = process.env;

    // Validate MASTER_API_KEY
    if (!MASTER_API_KEY) {
        throw new Error('MASTER_API_KEY environment variable is required');
    }

    // Validate input
    if (!input || !input.masterApiKey || input.masterApiKey !== MASTER_API_KEY) {
        throw new Error('Invalid or missing masterApiKey in input');
    }

    const {
        sessionId = 'default-session',
        action,
        messages = [],
        delayBetweenMessages = 2000, // Default 2 seconds delay
        waitForConnectionTimeout = 60000, // 60 seconds
    } = input;

    log.info('Starting WhatsApp API Actor', { sessionId, action, messageCount: messages.length });

    // Initialize client
    initializeClient(sessionId);

    // Wait for connection if needed
    if (action === 'send' || action === 'sendBulk') {
        log.info('Waiting for WhatsApp connection...');
        const connected = await waitForConnection(sessionId, waitForConnectionTimeout);
        if (!connected) {
            const session = sessions.get(sessionId);
            if (session && session.qrCode) {
                // Generate QR code image
                try {
                    const qrImageBuffer = await qrcode.toBuffer(session.qrCode);
                    const keyValueStore = await Apify.openKeyValueStore();
                    await keyValueStore.setValue('QR_CODE', qrImageBuffer, { contentType: 'image/png' });
                    log.info('QR code saved to key-value store as QR_CODE');
                } catch (err) {
                    log.error('Failed to save QR code', err);
                }
                throw new Error(`Session not connected. Please scan the QR code (saved as QR_CODE in key-value store). Current status: ${session.status}`);
            }
            throw new Error(`Session not connected within timeout. Current status: ${session?.status || 'Not found'}`);
        }
        log.info('WhatsApp connected successfully!');
    }

    // Handle different actions
    if (action === 'connect') {
        // Just initialize and return QR code if available
        const session = sessions.get(sessionId);
        await sleep(3000); // Wait a bit for QR code generation
        
        if (session && session.qrCode) {
            try {
                const qrImageBuffer = await qrcode.toBuffer(session.qrCode);
                const keyValueStore = await Apify.openKeyValueStore();
                await keyValueStore.setValue('QR_CODE', qrImageBuffer, { contentType: 'image/png' });
                log.info('QR code generated and saved to key-value store. Please scan it to connect.');
            } catch (err) {
                log.error('Failed to save QR code', err);
            }
            await Apify.pushData({
                success: true,
                sessionId,
                status: session.status,
                message: 'QR code generated. Please scan the QR code to connect.',
                qrCodeSaved: true
            });
        } else {
            await Apify.pushData({
                success: true,
                sessionId,
                status: session?.status || 'Initializing',
                message: 'Session initialized. Waiting for QR code...'
            });
        }
    } else if (action === 'send') {
        // Send a single message
        const { to, message, attachment, attachmentType, caption } = input;
        
        if (!to) {
            throw new Error('Missing required parameter: to (recipient phone number)');
        }

        if (attachment) {
            await sendAttachment(sessionId, to, attachment, caption || '', attachmentType);
            await Apify.pushData({
                success: true,
                sessionId,
                to,
                type: 'attachment',
                message: 'Attachment sent successfully'
            });
        } else if (message) {
            await sendMessage(sessionId, to, message);
            await Apify.pushData({
                success: true,
                sessionId,
                to,
                type: 'text',
                message: 'Message sent successfully'
            });
        } else {
            throw new Error('Missing required parameter: message or attachment');
        }
    } else if (action === 'sendBulk') {
        // Send bulk messages with delays
        if (!Array.isArray(messages) || messages.length === 0) {
            throw new Error('messages must be a non-empty array');
        }

        log.info(`Sending ${messages.length} messages with ${delayBetweenMessages}ms delay between each`);

        const results = [];
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            const { to, message, attachment, attachmentType, caption, delay } = msg;

            if (!to) {
                log.warning(`Skipping message ${i + 1}: missing 'to' parameter`);
                results.push({
                    index: i + 1,
                    success: false,
                    error: 'Missing required parameter: to'
                });
                continue;
            }

            try {
                // Use message-specific delay or default delay
                const currentDelay = delay !== undefined ? delay : delayBetweenMessages;

                if (attachment) {
                    await sendAttachment(sessionId, to, attachment, caption || '', attachmentType);
                    results.push({
                        index: i + 1,
                        success: true,
                        to,
                        type: 'attachment',
                        message: 'Attachment sent successfully'
                    });
                } else if (message) {
                    await sendMessage(sessionId, to, message);
                    results.push({
                        index: i + 1,
                        success: true,
                        to,
                        type: 'text',
                        message: 'Message sent successfully'
                    });
                } else {
                    throw new Error('Missing required parameter: message or attachment');
                }

                // Wait before sending next message (except for the last one)
                if (i < messages.length - 1 && currentDelay > 0) {
                    log.info(`Waiting ${currentDelay}ms before next message...`);
                    await sleep(currentDelay);
                }
            } catch (error) {
                log.error(`Error sending message ${i + 1} to ${to}:`, error);
                results.push({
                    index: i + 1,
                    success: false,
                    to,
                    error: error.message
                });
                // Continue with next message even if one fails
            }
        }

        const successCount = results.filter(r => r.success).length;
        const failCount = results.filter(r => !r.success).length;

        log.info(`Bulk send completed: ${successCount} successful, ${failCount} failed`);

        await Apify.pushData({
            success: true,
            sessionId,
            action: 'sendBulk',
            total: messages.length,
            successful: successCount,
            failed: failCount,
            results
        });
    } else {
        throw new Error(`Unknown action: ${action}. Supported actions: connect, send, sendBulk`);
    }

    log.info('Actor execution completed successfully');
});

