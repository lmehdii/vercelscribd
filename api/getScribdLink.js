// File: your-vercel-project/api/getScribdLink.js

// Use node-fetch v2 for require() compatibility in Vercel Node runtime
const fetch = require('node-fetch');

// --- Helper Functions (with subdomain fix) ---

function extractScribdInfo(url) {
     if (!url || typeof url !== 'string') {
        throw new Error('Invalid URL provided for extraction.');
    }
    // Regex with optional subdomain support
    const regex = /(?:[a-z]{2,3}\.)?scribd\.com\/(?:document|doc)\/(\d+)\/?([^?\/]+)?/;
    const match = url.match(regex);
    if (match && match[1]) {
        const docId = match[1];
        const titleSlug = match[2] ? match[2].replace(/\/$/, '') : `document-${docId}`;
        const title = titleSlug.replace(/-/g, ' ');
        console.log(`[Vercel Fn] Extracted via primary regex: ID=${docId}, Slug=${titleSlug}`);
        return { docId, title, titleSlug };
    } else {
        // Generic regex with optional subdomain support
        const genericMatch = /(?:[a-z]{2,3}\.)?scribd\.com\/.*\/(?:document|doc|presentation|book)\/(\d+)/;
         if (genericMatch && genericMatch[1]) {
             const docId = genericMatch[1];
             const titleSlug = `document-${docId}`;
             const title = `Document ${docId}`;
             console.warn("[Vercel Fn] Used generic Scribd URL matching.");
             return { docId, title, titleSlug };
         } else {
             console.error(`[Vercel Fn] Failed to match Scribd URL format: ${url}`);
            throw new Error('Invalid or unrecognized Scribd URL format.');
         }
    }
}

function generateIlideLink(docId, titleSlug) {
    const fileUrl = encodeURIComponent(`https://scribd.vdownloaders.com/pdownload/${docId}%2F${titleSlug}`);
    const titleWithSpaces = titleSlug.replace(/-/g, ' ');
    const encodedTitle = encodeURIComponent(`<div><p>${titleWithSpaces}</p></div>`);
    return `https://ilide.info/docgeneratev2?fileurl=${fileUrl}&title=${encodedTitle}&utm_source=scrfree&utm_medium=queue&utm_campaign=dl`;
}

// --- Vercel Serverless Function Handler ---
module.exports = async (req, res) => {
    // Only allow POST requests
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        // Use Vercel's response method
        return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
    }

    // --- Environment Variables (from Vercel settings) ---
    const apiKey = process.env.BROWSERLESS_API_KEY;
    const blockScripts = process.env.BLOCK_SCRIPTS === 'true';
    const browserlessDomain = process.env.BROWSERLESS_DOMAIN || 'production-sfo.browserless.io';

    if (!apiKey) {
        console.error("[Vercel Fn] BROWSERLESS_API_KEY environment variable is not set.");
        return res.status(500).json({ error: 'Server configuration error: Missing API Key.' });
    }

    // --- Request Body Parsing (Vercel usually parses JSON body automatically) ---
    const { scribdUrl } = req.body;
    if (!scribdUrl || typeof scribdUrl !== 'string') {
        console.error("[Vercel Fn] Invalid request body:", req.body);
        return res.status(400).json({ error: 'Missing or invalid scribdUrl in request body.' });
    }

    console.log(`[Vercel Fn] Request for: ${scribdUrl}. Script Blocking: ${blockScripts}`);

    try {
        // 1. Generate Links (Using updated extractScribdInfo)
        console.log("[Vercel Fn] Extracting Scribd info...");
        const { docId, title, titleSlug } = extractScribdInfo(scribdUrl);
        const ilideLink = generateIlideLink(docId, titleSlug);
        console.log(`[Vercel Fn] Target ilide.info link: ${ilideLink}`);

        // 2. **** Optimized Puppeteer Script (with simplified logs) ****
        const puppeteerScriptV2 = `
            export default async function ({ page, context }) {
                const { ilideLink, blockScripts } = context;
                let capturedLink = null;
                let navigationError = null;
                console.log('B2: Script started. blockScripts=${blockScripts}. URL:', ilideLink);

                // Request Interception
                await page.setRequestInterception(true);
                page.on('request', (request) => {
                    const resourceType = request.resourceType();
                    const blockList = ['image', 'stylesheet', 'font', 'media'];
                    if (blockScripts && resourceType === 'script') {
                         console.log('B2: Blocking Script:', request.url());
                         request.abort();
                    } else if (blockList.includes(resourceType)) {
                        request.abort();
                    } else {
                        request.continue();
                    }
                });

                // Response Listener
                page.on('response', async (response) => {
                     const url = response.url();
                     if (url.includes('viewer/web/viewer.html') && url.includes('file=')) {
                        try {
                             const urlObj = new URL(url); const fileParam = urlObj.searchParams.get('file');
                             if (fileParam) { let decodedLink = decodeURIComponent(fileParam); try { decodedLink = decodeURIComponent(decodedLink); } catch(e){} capturedLink = decodedLink; console.log('B2: Captured target link:', capturedLink); }
                        } catch (err) { console.error('B2: Error parsing viewer URL:', err.message); }
                     }
                });

                // Navigation
                try {
                    console.log('B2: Navigating (using domcontentloaded)...');
                    await page.goto(ilideLink, { waitUntil: 'domcontentloaded', timeout: 55000 });
                    console.log('B2: DOMContentLoaded fired.');

                    const postNavWait = blockScripts ? 500 : 1500;
                    console.log(\`B2: Waiting \${postNavWait}ms post-DOM load...\`);
                    await new Promise(resolve => setTimeout(resolve, postNavWait));
                    console.log('B2: Post-DOM wait finished.');

                } catch (error) {
                    console.error('B2: Navigation/processing error:', error);
                    navigationError = error;
                }

                // Check results
                if (capturedLink) {
                    console.log('B2: Link captured, returning it.');
                    return { data: capturedLink, type: 'text/plain' };
                } else if (navigationError) {
                    console.error('B2: No link captured & navigation failed.');
                    throw new Error('Browserless execution failed: ' + navigationError.message);
                } else {
                    console.error('B2: Navigation seemingly succeeded but target link response not detected.');
                    throw new Error('Download link response not detected on ilide.info.');
                }
            }
        `;

        // 3. Prepare Browserless Payload
        const apiPayload = {
            code: puppeteerScriptV2,
            context: {
                ilideLink: ilideLink,
                blockScripts: blockScripts
            }
        };

        // 4. Call Browserless API
        const browserlessUrl = `https://${browserlessDomain}/function?token=${apiKey}&timeout=60000`;
        console.log(`[Vercel Fn] Sending request to ${browserlessUrl}`);
        const browserlessResponse = await fetch(browserlessUrl, {
             method: 'POST',
             headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
             body: JSON.stringify(apiPayload)
        });
        const responseStatus = browserlessResponse.status;
        console.log(`[Vercel Fn] Received response from Browserless. Status: ${responseStatus}`);

        // 5. Handle Browserless Response
        if (!browserlessResponse.ok) {
            const errorBody = await browserlessResponse.text();
            console.error(`[Vercel Fn] Browserless Error! Status: ${responseStatus}, Body: ${errorBody}`);
            let detail = errorBody;
            try { detail = JSON.parse(errorBody).message || errorBody; } catch (e) {}
            const clientStatusCode = [400, 401, 403, 429].includes(responseStatus) ? responseStatus : 502;
            // Use Vercel's response method
            return res.status(clientStatusCode).json({ error: `Upstream API Error (${responseStatus}): ${detail}` });
        }

        // 6. Process Successful Response
        const resultData = await browserlessResponse.json();
        if (!resultData || typeof resultData.data !== 'string' || !resultData.data.startsWith('http')) {
             console.error("[Vercel Fn] Invalid data structure or link from Browserless:", resultData);
             // Use Vercel's response method
            return res.status(502).json({ error: "Bad Gateway: Received invalid response format from upstream service." });
        }

        // 7. Return Link to Frontend (via Netlify proxy)
        const directDownloadLink = resultData.data;
        console.log("[Vercel Fn] Successfully obtained direct link:", directDownloadLink);
        // Use Vercel's response method
        return res.status(200).json({ downloadLink: directDownloadLink });

    } catch (error) {
        // Catch internal Vercel function errors
        console.error("[Vercel Fn] Internal error:", error);
        const statusCode = error.message.includes("Scribd URL format") ? 400 : 500;
        // Use Vercel's response method
        return res.status(statusCode).json({ error: error.message || 'An internal server error occurred.' });
    }
};
