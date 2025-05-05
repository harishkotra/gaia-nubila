// server.js
require('dotenv').config();
const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const NUBILA_API_KEY = process.env.NUBILA_API_KEY;
const GAIA_API_ENDPOINT = process.env.GAIA_API_ENDPOINT;
const GAIA_API_KEY = process.env.GAIA_API_KEY;
const GAIA_MODEL_NAME = process.env.GAIA_MODEL_NAME;

if (!NUBILA_API_KEY) {
    console.error("Error: NUBILA_API_KEY is not defined in .env file.");
    process.exit(1);
}
if (!GAIA_API_ENDPOINT) {
    console.error("Error: GAIA_API_ENDPOINT is not defined in .env file.");
    process.exit(1);
}
if (!GAIA_API_KEY) {
    console.error("Error: GAIA_API_KEY is not defined in .env file.");
    process.exit(1);
}
if (!GAIA_MODEL_NAME) {
    console.error("Error: GAIA_MODEL_NAME is not defined in .env file.");
    process.exit(1);
}

// --- Middleware ---
app.use(cors()); // Allow requests from frontend
app.use(express.json()); // Parse JSON request bodies
app.use(express.static('public')); // Serve static files from 'public' directory

// Function to call Gaia API
async function analyzeQueryWithGaia(query) {
    console.log(`Querying Gaia for: "${query}"`);
    const prompt = `
Analyze the user's weather request. Extract the location name, its approximate latitude, and longitude.
Also determine if the user wants 'current' weather or a 'forecast'.

Respond ONLY with a valid JSON object containing:
- "locationName": string (the extracted location)
- "latitude": number | null (approximate latitude, null if unknown)
- "longitude": number | null (approximate longitude, null if unknown)
- "requestType": "current" | "forecast" (the type of weather info requested)

User Request: "${query}"

JSON Response:
`;

    try {
        const response = await fetch(GAIA_API_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GAIA_API_KEY}`
            },
            body: JSON.stringify({
                model: `${GAIA_MODEL_NAME}`, // Or appropriate model for the endpoint
                messages: [{ role: "user", content: prompt }],
                temperature: 0.2, // Low temperature for deterministic results
                max_tokens: 150
            })
        });

        if (!response.ok) {
            const errorBody = await response.text();
            console.error(`Gaia API Error (${response.status}): ${errorBody}`);
            throw new Error(`Gaia API request failed with status ${response.status}`);
        }

        const data = await response.json();

        // Extract the JSON part from the response content
        const content = data.choices[0]?.message?.content;
        if (!content) {
            console.error("Gaia response missing content:", data);
            throw new Error('Invalid response format from Gaia: No content.');
        }

        console.log("Raw Gaia Response Content:", content);

        // Attempt to parse the JSON from the content string
        try {
            // Find the start and end of the JSON object
            const jsonStart = content.indexOf('{');
            const jsonEnd = content.lastIndexOf('}');
            if (jsonStart === -1 || jsonEnd === -1) {
                 throw new Error('Could not find JSON object in Gaia response.');
            }
            const jsonString = content.substring(jsonStart, jsonEnd + 1);
            const analysis = JSON.parse(jsonString);

            console.log("Parsed Gaia Analysis:", analysis);

            // Basic validation
            if (!analysis.locationName || typeof analysis.requestType === 'undefined') {
                 throw new Error('Gaia response missing required fields (locationName, requestType).');
            }
             if (typeof analysis.latitude !== 'number' || typeof analysis.longitude !== 'number') {
                 console.warn("Gaia did not provide valid coordinates. Nubila query might fail.");
                 // Allow proceeding but coordinates might be invalid for Nubila
                 analysis.latitude = analysis.latitude || null; // Ensure null if invalid
                 analysis.longitude = analysis.longitude || null; // Ensure null if invalid
             }


            return analysis;
        } catch (parseError) {
            console.error("Error parsing Gaia JSON response:", parseError);
            console.error("Problematic content string:", content);
            throw new Error(`Failed to parse JSON from Gaia response: ${parseError.message}`);
        }

    } catch (error) {
        console.error("Error calling Gaia API:", error);
        throw new Error(`Could not analyze query with Gaia: ${error.message}`); // Rethrow for handling in the route
    }
}

// Function to call Nubila API
async function getNubilaWeather(lat, lon, type = 'current') {
    if (lat === null || lon === null || typeof lat !== 'number' || typeof lon !== 'number') {
        throw new Error("Invalid or missing latitude/longitude for Nubila API call.");
    }

    const endpoint = type === 'forecast' ? 'forecast' : 'weather';
    const url = `https://api.nubila.ai/api/v1/${endpoint}?lat=${lat}&lon=${lon}`;
    console.log(`Querying Nubila: ${url} (Type: ${type})`);

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'X-Api-Key': NUBILA_API_KEY
            }
        });

        const data = await response.json();

        if (!response.ok || data.ok === false) {
            console.error(`Nubila API Error (${response.status}):`, data);
            throw new Error(data.message || `Nubila API request failed with status ${response.status}`);
        }

        console.log("Nubila API Success Response:", data);
        return data; // Return the whole response (includes 'ok' and 'data' fields)

    } catch (error) {
        console.error("Error calling Nubila API:", error);
        throw new Error(`Could not fetch weather data from Nubila: ${error.message}`); // Rethrow
    }
}

app.post('/api/weather-info', async (req, res) => {
    const { query } = req.body;

    if (!query || typeof query !== 'string' || query.trim() === '') {
        return res.status(400).json({ ok: false, message: "Query parameter is required." });
    }

    try {
        // 1. Analyze query with Gaia
        const analysis = await analyzeQueryWithGaia(query);

        if (!analysis || analysis.latitude === null || analysis.longitude === null) {
             return res.status(400).json({ ok: false, message: `Could not determine valid coordinates for "${analysis?.locationName || query}". Please be more specific.` });
        }

        // 2. Get weather from Nubila based on analysis
        const weatherData = await getNubilaWeather(analysis.latitude, analysis.longitude, analysis.requestType);

        // 3. Send successful response back to frontend
        res.json({
            ok: true,
            requestDetails: analysis,
            weatherData: weatherData
        });

    } catch (error) {
        console.error("Error processing weather request:", error);
        // Send specific error message back to frontend
        res.status(500).json({ ok: false, message: error.message || "An internal server error occurred." });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});