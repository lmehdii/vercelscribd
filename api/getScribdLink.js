// Use node-fetch for compatibility with Vercel's Node.js runtime (v2 for CommonJS)
const fetch = require('node-fetch');

// --- Helper Functions (Copied from previous attempts) ---

function extractScribdInfo(url) {
    if (!url || typeof url !== 'string') {
        throw new Error('Invalid URL provided for extraction.');
    }
    const regex = /scribd\.com\/(?:document|doc)\/(\d+)\/?([^?\/]+)?/;
    const match = url.match(regex);
    if (match && match[1]) {
        const docId = match[1];
        const titleSlug = match[2] ? match[2].replace(/\/$/, '') : `document-${docId}`;
        const title = titleSlug.replace(/-/g, ' ');
        return { docId, title, titleSlug };
    } else {
        // Try a more generic approach if the first regex fails
        const genericMatch = url.match(/scribd\.com\/.*\/(?:document|doc|presentation|book)\/(\d+)/);
         if (genericMatch && genericMatch[1]) {
             const docId = genericMatch[1];
             // Cannot reliably get title slug here, create a default one
             const titleSlug = `document-${docId}`;
             const title = `Document ${docId}`;
             console.warn("Used generic Scribd URL matching.");
             return { docId, title, titleSlug };
         } else {
            throw new Error('Invalid or unrecognized Scribd URL format.');
         }
    }
}

function generateIlideLink(docId, titleSlug) {
    const fileUrl = encodeURIComponent(`https://scribd.vdownloaders.com/pdownload/${docId}%2F${titleSlug}`);
    const titleWithSpaces = titleSlug.replace(/-/g, ' ');
    const encodedTitle = encodeURIComponent(`<div><p>${titleWithSpaces}</p></div>`);
    // Ensure base URL is correct
    return `https://ilide.info/docgeneratev2?fileurl=${fileUrl}&title=${encodedTitle}&utm_source=scrfree&utm_medium=queue&utm_campaign=dl`;
}


// --- Vercel Serverless Function Handler ---

module.exports = async (req, res) => {
    // Only allow POST requests
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
    }

    // Get Browserless API Key from Vercel Environment Variables
    const apiKey = process.env.BROWSERLESS_API_KEY;
    if (!apiKey) {
        console.error("BROWSERLESS_API_KEY environment variable is not set.");
        return res.status(500).json({ error: 'Server configuration error: Missing API Key.' });
    }

    // Get scribdUrl from the request body sent by the frontend
    const { scribdUrl } = req.body;
    if (!scribdUrl) {
        return res.status(400).json({ error: 'Missing scribdUrl in request body.' });
    }

    console.log(`[API] Received request for Scribd URL: ${scribdUrl}`);

    try {
        // 1. Parse Scribd URL and generate ilide link
        console.log("[API] Extracting Scribd info...");
        const { docId, title, titleSlug } = extractScribdInfo(scribdUrl);
        const ilideLink = generateIlideLink(docId, titleSlug);
        console.log(`[API] Generated ilide.info link: ${ilideLink}`);

        // 2. Define the Puppeteer script string using V2 ESM syntax
        // **** Corrected the wait mechanism ****
        const puppeteerScriptV2 = `
            export default async function ({ page, context }) {
                const { ilideLink } = context;
                let capturedLink = null;
                console.log('[Browserless V2] Received ilideLink:', ilideLink);

                page.on('response', async (response) => {
                    const url = response.url();
                    if (url.includes('viewer/web/viewer.html') && url.includes('file=')) {
                        try {
                            const urlObj = new URL(url);
                            const fileParam = urlObj.searchParams.get('file');
                            if (fileParam) {
                                let decodedLink = decodeURIComponent(fileParam);
                                try { decodedLink = decodeURIComponent(decodedLink); } catch(e){}
                                capturedLink = decodedLink;
                                console.log('[Browserless V2] Captured direct link:', capturedLink);
                            }
                        } catch (err) {
                            console.error('[Browserless V2] Error parsing viewer URL:', err.message);
                        }
                    }
                });

                try {
                    console.log('[Browserless V2] Navigating to:', ilideLink);
                    await page.goto(ilideLink, { waitUntil: 'networkidle0', timeout: 60000 });
                    console.log('[Browserless V2] Navigation complete.');

                    // **** Use standard Promise/setTimeout for delay ****
                    console.log('[Browserless V2] Waiting for 5 seconds...');
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    console.log('[Browserless V2] Extra wait finished.');

                    if (capturedLink) {
                        console.log('[Browserless V2] Returning captured link.');
                        return { data: capturedLink, type: 'text/plain' };
                    } else {
                        console.error('[Browserless V2] Failed to capture link.');
                        throw new Error('Download link not found automatically on ilide.info.');
                    }
                } catch (navError) {
                    console.error('[Browserless V2] Navigation/processing error:', navError);
                    throw new Error('Browserless execution failed: ' + navError.message);
                }
            }
        `;

        // 3. Prepare the payload for Browserless
        const apiPayload = {
            code: puppeteerScriptV2,
            context: { ilideLink: ilideLink }
        };

        // 4. Call the Browserless.io V2 /function endpoint
        // Use corrected timeout value
        const browserlessUrl = `https://production-sfo.browserless.io/function?token=${apiKey}&timeout=60000`;
        console.log(`[API] Sending request to Browserless V2: ${browserlessUrl}`);

        const browserlessResponse = await fetch(browserlessUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache'
            },
            body: JSON.stringify(apiPayload)
        });

        console.log(`[API] Received response from Browserless. Status: ${browserlessResponse.status}`);

        if (!browserlessResponse.ok) {
            const errorBody = await browserlessResponse.text();
            console.error("[API] Browserless Error Body:", errorBody);
            let detail = errorBody;
             try {
                 // Check if Browserless returned JSON with error detail
                 const errorJson = JSON.parse(errorBody);
                 if (errorJson && errorJson.message) {
                     detail = errorJson.message; // Use the specific message if available
                 }
             } catch(e){}
            // Send appropriate status code back to frontend
             const statusCode = browserlessResponse.status === 401 || browserlessResponse.status === 403 ? 500 : 502;
            return res.status(statusCode).json({ error: `Browserless API Error (${browserlessResponse.status}): ${detail}` });
        }

        // 5. Get the result from Browserless
        const resultData = await browserlessResponse.json();

        if (!resultData || typeof resultData.data !== 'string' || !resultData.data.startsWith('http')) {
             console.error("[API] Invalid data structure or link from Browserless:", resultData);
            return res.status(502).json({ error: "Bad Gateway: Received invalid response from downstream service (Browserless)." });
        }

        const directDownloadLink = resultData.data;
        console.log("[API] Successfully obtained direct link:", directDownloadLink);

        // 6. Send the successful result back to the frontend
        return res.status(200).json({ downloadLink: directDownloadLink });

    } catch (error) {
        // Catch errors from parsing, generating link, or unexpected issues
        console.error("[API] An internal error occurred:", error);
        // Send a generic 500 Internal Server Error for unexpected issues
        return res.status(500).json({ error: error.message || 'An internal server error occurred.' });
    }
};
