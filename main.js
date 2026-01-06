const Apify = require('apify');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

// Use Apify logging - handle both v2 and v3 SDK
const log = Apify.utils?.log || Apify.log || console;

// Path to the sessions directory
// Use Apify's storage directory or fallback to a local directory
const getSessionsDir = async () => {
    try {
        const env = Apify.getEnv ? Apify.getEnv() : await Apify.getEnv();
        // Use storage directory if available, otherwise use current working directory
        if (env && env.defaultDatasetPath) {
            // Sessions should be stored in a persistent location
            // Use the storage directory structure
            const storageDir = path.dirname(path.dirname(env.defaultDatasetPath));
            return path.join(storageDir, 'sessions');
        }
    } catch (e) {
        if (log.warning) {
            log.warning('Could not get Apify environment, using fallback path', e);
        } else {
            console.warn('Could not get Apify environment, using fallback path', e);
        }
    }
    // Fallback: use current working directory or /tmp for sessions
    return path.join(process.cwd(), 'sessions');
};

// In-memory store for WhatsApp clients and their statuses
const sessions = new Map();

/**
 * Checks if a session already exists (has been authenticated before)
 * @param {string} sessionId - The session ID.
 * @returns {boolean} True if session data exists.
 */
const sessionExists = (sessionId, sessionsDir) => {
    const sessionDataPath = path.join(sessionsDir, `session-${sessionId}`);
    return fs.existsSync(sessionDataPath) && fs.existsSync(path.join(sessionDataPath, '.wwebjs_auth'));
};

/**
 * Initializes or retrieves a WhatsApp client for a given session ID.
 * @param {string} sessionId - The unique identifier for the session.
 * @param {string} sessionsDir - The sessions directory path.
 * @returns {Object} The session object with client and status.
 */
const initializeClient = (sessionId, sessionsDir) => {
    if (sessions.has(sessionId) && sessions.get(sessionId).client) {
        return sessions.get(sessionId);
    }

    if (log.info) {
        log.info(`Initializing WhatsApp client for session: ${sessionId}`);
    } else {
        console.log(`Initializing WhatsApp client for session: ${sessionId}`);
    }
    const sessionDataPath = path.join(sessionsDir, `session-${sessionId}`);

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
        if (log.info) {
            log.info(`QR code received for session: ${sessionId}`);
        } else {
            console.log(`QR code received for session: ${sessionId}`);
        }
        session.qrCode = qr;
        session.status = 'QR Code Generated';
    });

    client.on('ready', () => {
        if (log.info) {
            log.info(`WhatsApp client is ready for session: ${sessionId}. Session data saved!`);
        } else {
            console.log(`WhatsApp client is ready for session: ${sessionId}. Session data saved!`);
        }
        session.qrCode = null;
        session.status = 'Connected';
    });

    client.on('authenticated', () => {
        if (log.info) {
            log.info(`Authentication successful for session: ${sessionId}. You can now use this sessionId for sending messages.`);
        } else {
            console.log(`Authentication successful for session: ${sessionId}. You can now use this sessionId for sending messages.`);
        }
        session.status = 'Connected';
    });

    client.on('auth_failure', (msg) => {
        if (log.error) {
            log.error(`Authentication failure for session ${sessionId}:`, msg);
        } else {
            console.error(`Authentication failure for session ${sessionId}:`, msg);
        }
        session.status = 'Authentication Failure';
        // Clean up and remove the failed session
        if (fs.existsSync(sessionDataPath)) {
            fs.rmSync(sessionDataPath, { recursive: true, force: true });
        }
        sessions.delete(sessionId);
    });

    client.on('disconnected', (reason) => {
        if (log.info) {
            log.info(`Client for session ${sessionId} was logged out:`, reason);
        } else {
            console.log(`Client for session ${sessionId} was logged out:`, reason);
        }
        session.status = 'Disconnected';
        const errorHandler = (err) => {
            if (log.error) {
                log.error(`Error destroying client for session ${sessionId}:`, err);
            } else {
                console.error(`Error destroying client for session ${sessionId}:`, err);
            }
        };
        client.destroy().catch(errorHandler);
        sessions.delete(sessionId);
    });

    client.initialize().catch(err => {
        if (log.error) {
            log.error(`Failed to initialize client for session ${sessionId}:`, err);
        } else {
            console.error(`Failed to initialize client for session ${sessionId}:`, err);
        }
        sessions.delete(sessionId);
    });

    return session;
};

/**
 * Waits for a session to be connected.
 * @param {string} sessionId - The session ID.
 * @param {number} timeout - Maximum time to wait in milliseconds.
 * @returns {Promise<{connected: boolean, qrCode?: string, status?: string}>} Connection status.
 */
const waitForConnection = async (sessionId, timeout = 60000) => {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        const session = sessions.get(sessionId);
        if (session && session.status === 'Connected') {
            return { connected: true };
        }
        if (session && session.qrCode) {
            return { connected: false, qrCode: session.qrCode, status: session.status };
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const session = sessions.get(sessionId);
    return { connected: false, status: session?.status || 'Not found' };
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
    if (log.info) {
        log.info(`Message sent to ${to} from session ${sessionId}`);
    } else {
        console.log(`Message sent to ${to} from session ${sessionId}`);
    }
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
    if (log.info) {
        log.info(`Attachment sent to ${to} from session ${sessionId}`);
    } else {
        console.log(`Attachment sent to ${to} from session ${sessionId}`);
    }
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
        action = 'sendBulk',
        messages = [],
        delayBetweenMessages = 2000, // Default 2 seconds delay
        waitForConnectionTimeout = 120000, // 120 seconds for first-time connection
    } = input;

    if (log.info) {
        log.info('Starting WhatsApp API Actor', { sessionId, action, messageCount: messages.length });
    } else {
        console.log('Starting WhatsApp API Actor', { sessionId, action, messageCount: messages.length });
    }

    // Get sessions directory
    const SESSIONS_DIR = await getSessionsDir();
    
    // Ensure the sessions directory exists
    if (!fs.existsSync(SESSIONS_DIR)) {
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    }

    // Check if session already exists
    const existingSession = sessionExists(sessionId, SESSIONS_DIR);
    if (existingSession && (action === 'send' || action === 'sendBulk')) {
        if (log.info) {
            log.info(`Session ${sessionId} already exists. Using saved session data.`);
        } else {
            console.log(`Session ${sessionId} already exists. Using saved session data.`);
        }
    }

    // Initialize client
    initializeClient(sessionId, SESSIONS_DIR);

    // Wait for connection if needed
    if (action === 'send' || action === 'sendBulk') {
        if (log.info) {
            log.info('Waiting for WhatsApp connection...');
        } else {
            console.log('Waiting for WhatsApp connection...');
        }
        const connectionResult = await waitForConnection(sessionId, waitForConnectionTimeout);
        if (!connectionResult.connected) {
            if (connectionResult.qrCode) {
                // Generate QR code image and save it
                try {
                    const qrImageBuffer = await qrcode.toBuffer(connectionResult.qrCode);
                    const keyValueStore = await Apify.openKeyValueStore();
                    await keyValueStore.setValue('QR_CODE', qrImageBuffer, { contentType: 'image/png' });
                    const qrText = connectionResult.qrCode;
                    await keyValueStore.setValue('QR_CODE_TEXT', qrText);
                    
                    if (log.info) {
                        log.info('QR code generated! Check the Key-Value Store for QR_CODE (image) and QR_CODE_TEXT (text).');
                        log.info('Please scan the QR code to connect. After scanning, use the same sessionId for sending messages.');
                    } else {
                        console.log('QR code generated! Check the Key-Value Store for QR_CODE (image) and QR_CODE_TEXT (text).');
                        console.log('Please scan the QR code to connect. After scanning, use the same sessionId for sending messages.');
                    }
                    
                    // Also output QR code text in logs
                    console.log('\n=== QR CODE TEXT (Scan this with WhatsApp) ===');
                    console.log(qrText);
                    console.log('==============================================\n');
                } catch (err) {
                    if (log.error) {
                        log.error('Failed to save QR code', err);
                    } else {
                        console.error('Failed to save QR code', err);
                    }
                }
                throw new Error(`Session not connected. Please scan the QR code from Key-Value Store (QR_CODE) or logs above. After scanning, run again with the same sessionId: "${sessionId}". Current status: ${connectionResult.status}`);
            }
            throw new Error(`Session not connected within timeout. Current status: ${connectionResult.status}. If this is your first time, use action: "connect" to generate a QR code.`);
        }
        if (log.info) {
            log.info('WhatsApp connected successfully! Session data saved. You can now use this sessionId for future runs.');
        } else {
            console.log('WhatsApp connected successfully! Session data saved. You can now use this sessionId for future runs.');
        }
    }

    // Handle different actions
    if (action === 'connect') {
        // Wait for QR code generation (up to 30 seconds)
        if (log.info) {
            log.info('Waiting for QR code generation...');
        } else {
            console.log('Waiting for QR code generation...');
        }
        
        let qrCodeReceived = false;
        const maxWaitTime = 30000; // 30 seconds
        const startTime = Date.now();
        
        while (Date.now() - startTime < maxWaitTime && !qrCodeReceived) {
            const session = sessions.get(sessionId);
            if (session && session.qrCode) {
                qrCodeReceived = true;
                try {
                    const qrImageBuffer = await qrcode.toBuffer(session.qrCode);
                    const keyValueStore = await Apify.openKeyValueStore();
                    await keyValueStore.setValue('QR_CODE', qrImageBuffer, { contentType: 'image/png' });
                    await keyValueStore.setValue('QR_CODE_TEXT', session.qrCode);
                    
                    if (log.info) {
                        log.info('QR code generated and saved to Key-Value Store!');
                        log.info(`Session ID: ${sessionId}`);
                        log.info('Please scan the QR code to connect. After scanning, save this sessionId and use it for sending messages.');
                    } else {
                        console.log('QR code generated and saved to Key-Value Store!');
                        console.log(`Session ID: ${sessionId}`);
                        console.log('Please scan the QR code to connect. After scanning, save this sessionId and use it for sending messages.');
                    }
                    
                    // Output QR code in logs
                    console.log('\n=== QR CODE TEXT (Scan this with WhatsApp) ===');
                    console.log(session.qrCode);
                    console.log('==============================================');
                    console.log(`\nIMPORTANT: Save this Session ID: "${sessionId}"`);
                    console.log('After scanning the QR code, use this sessionId in future runs to send messages.\n');
                    
                    await Apify.pushData({
                        success: true,
                        sessionId,
                        status: session.status,
                        message: `QR code generated! Scan it to connect. Save this sessionId: "${sessionId}" for future use.`,
                        qrCodeSaved: true,
                        instructions: '1. Scan the QR code from Key-Value Store (QR_CODE) or logs above. 2. After scanning, use the same sessionId for sending messages.'
                    });
                } catch (err) {
                    if (log.error) {
                        log.error('Failed to save QR code', err);
                    } else {
                        console.error('Failed to save QR code', err);
                    }
                }
                break;
            }
            await sleep(1000); // Wait 1 second before checking again
        }
        
        if (!qrCodeReceived) {
            const session = sessions.get(sessionId);
            await Apify.pushData({
                success: false,
                sessionId,
                status: session?.status || 'Initializing',
                message: 'QR code not generated yet. Please wait and check again, or the session may already be connected.'
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

        if (log.info) {
            log.info(`Sending ${messages.length} messages with ${delayBetweenMessages}ms delay between each`);
        } else {
            console.log(`Sending ${messages.length} messages with ${delayBetweenMessages}ms delay between each`);
        }

        const results = [];
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            const { to, message, attachment, attachmentType, caption, delay } = msg;

            if (!to) {
                if (log.warning) {
                    log.warning(`Skipping message ${i + 1}: missing 'to' parameter`);
                } else {
                    console.warn(`Skipping message ${i + 1}: missing 'to' parameter`);
                }
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
                    if (log.info) {
                        log.info(`Waiting ${currentDelay}ms before next message...`);
                    } else {
                        console.log(`Waiting ${currentDelay}ms before next message...`);
                    }
                    await sleep(currentDelay);
                }
            } catch (error) {
                if (log.error) {
                    log.error(`Error sending message ${i + 1} to ${to}:`, error);
                } else {
                    console.error(`Error sending message ${i + 1} to ${to}:`, error);
                }
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

        if (log.info) {
            log.info(`Bulk send completed: ${successCount} successful, ${failCount} failed`);
        } else {
            console.log(`Bulk send completed: ${successCount} successful, ${failCount} failed`);
        }

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

    if (log.info) {
        log.info('Actor execution completed successfully');
    } else {
        console.log('Actor execution completed successfully');
    }
});

