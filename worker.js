const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/**
 * Obtains an ephemeral Yahoo session cookie and authorization crumb.
 */
async function getYahooCredentials() {
    // Step 1: Hit fc.yahoo.com to acquire the initial session cookie
    const initRes = await fetch("https://fc.yahoo.com", {
        headers: { "User-Agent": USER_AGENT }
    });

    const rawCookie = initRes.headers.get("set-cookie") || "";
    const cookieMatch = rawCookie.match(/(A[13]=[^;]+)/);
    const cookie = cookieMatch ? cookieMatch[1] : "";

    // Step 2: Use the cookie to request the session crumb
    const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
        headers: {
            "User-Agent": USER_AGENT,
            "Cookie": cookie
        }
    });

    if (!crumbRes.ok) {
        throw new Error(`Failed to acquire Yahoo crumb (HTTP ${crumbRes.status})`);
    }

    const crumb = await crumbRes.text();
    return { cookie, crumb: crumb.trim() };
}

export default {
    async fetch(request, env) {
        // 1. Handle CORS Preflight
        if (request.method === "OPTIONS") {
            return new Response(null, {
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization"
                }
            });
        }

        const url = new URL(request.url);
        const action = url.searchParams.get("action");
        const symbol = (url.searchParams.get("symbol") || url.searchParams.get("ticker") || "").toUpperCase();

        const corsHeaders = {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
        };

        try {
            // --- ACTION 1: Finnhub Company News ---
            if (action === "news") {
                if (!symbol) throw new Error("Missing symbol for news.");
                const toDate = new Date().toISOString().split("T")[0];
                const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
                const finnhubKey = env.FINNHUB_KEY || env.FINNHUB_API_KEY;

                const res = await fetch(
                    `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${fromDate}&to=${toDate}&token=${finnhubKey}`
                );
                const data = await res.json();
                return new Response(JSON.stringify(data), { headers: corsHeaders });
            }

            // --- ACTION 2: Gemini AI Chat / Intent Routing ---
            if (action === "gemini") {
                const geminiKey = env.GEMINI_KEY || env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
                if (!geminiKey) {
                    return new Response(JSON.stringify({
                        error: "Gemini key is missing from Worker environment variables. Set GEMINI_KEY in Cloudflare settings."
                    }), { status: 500, headers: corsHeaders });
                }

                const body = await request.json().catch(() => ({}));
                const prompt = body.prompt;

                if (!prompt) {
                    return new Response(JSON.stringify({ error: "Missing 'prompt' in request body." }), {
                        status: 400,
                        headers: corsHeaders
                    });
                }

                // High-allowance Lite models (500 RPD) prioritized over 20 RPD tier models
                const candidateModels = [
                    body.model || "gemini-3.5-flash-lite",
                    "gemini-3.1-flash-lite",
                    "gemini-3.7-flash",
                    "gemini-3.6-flash"
                ];

                let lastResponse = null;
                let lastData = null;

                for (const rawModel of candidateModels) {
                    const modelName = rawModel.startsWith("models/") ? rawModel : `models/${rawModel}`;

                    try {
                        const res = await fetch(
                            `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${encodeURIComponent(geminiKey.trim())}`,
                            {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                    contents: [{ parts: [{ text: prompt }] }]
                                })
                            }
                        );

                        const data = await res.json();

                        if (res.ok) {
                            return new Response(JSON.stringify(data), {
                                status: 200,
                                headers: corsHeaders
                            });
                        }

                        lastResponse = res;
                        lastData = data;

                        // Continue through the list if throttled, quota-exhausted, or under high load
                        if (res.status === 503 || res.status === 429 || res.status === 404) {
                            console.warn(`[Gemini Proxy]: ${modelName} returned HTTP ${res.status}. Trying next candidate...`);
                            continue;
                        }

                        break;
                    } catch (err) {
                        console.error(`[Gemini Proxy Error]:`, err);
                    }
                }

                return new Response(JSON.stringify(lastData || { error: "All candidate models exhausted or rate-limited." }), {
                    status: lastResponse ? lastResponse.status : 500,
                    headers: corsHeaders
                });
            }

            // --- ACTION 3: Fallback Provider Quote (Finnhub / TwelveData) ---
            if (action === "provider-quote") {
                const provider = url.searchParams.get("provider");
                if (provider === "finnhub") {
                    const finnhubKey = env.FINNHUB_KEY || env.FINNHUB_API_KEY;
                    const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${finnhubKey}`);
                    const data = await res.json();
                    return new Response(JSON.stringify(data), { headers: corsHeaders });
                }
                if (provider === "twelvedata") {
                    const tdKey = env.TWELVE_KEY || env.TWELVEDATA_KEY;
                    const res = await fetch(`https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${tdKey}`);
                    const data = await res.json();
                    return new Response(JSON.stringify(data), { headers: corsHeaders });
                }
            }

            // --- DEFAULT ACTION: Yahoo Deep Stock Data & Live Quotes ---
            if (!symbol) {
                return new Response(JSON.stringify({ error: "Missing required 'symbol' or 'action' parameter." }), {
                    status: 400,
                    headers: corsHeaders
                });
            }

            // Obtain session credentials
            const { cookie, crumb } = await getYahooCredentials();

            const yahooUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=price,summaryDetail,defaultKeyStatistics,financialData,recommendationTrend,upgradeDowngradeHistory,calendarEvents&crumb=${encodeURIComponent(crumb)}`;

            const response = await fetch(yahooUrl, {
                headers: {
                    "User-Agent": USER_AGENT,
                    "Cookie": cookie
                }
            });

            if (!response.ok) {
                throw new Error(`Yahoo returned HTTP ${response.status}`);
            }

            const raw = await response.json();
            const result = raw.quoteSummary?.result?.[0] || {};

            const payload = {
                symbol,
                price: {
                    current: result.price?.regularMarketPrice?.raw ?? null,
                    previousClose: result.price?.regularMarketPreviousClose?.raw ?? null,
                    change: result.price?.regularMarketChange?.raw ?? null,
                    changePercent: result.price?.regularMarketChangePercent?.raw ?? null
                },
                valuation: {
                    peTrailing: result.summaryDetail?.trailingPE?.raw ?? null,
                    peForward: result.summaryDetail?.forwardPE?.raw ?? null,
                    pegRatio: result.defaultKeyStatistics?.pegRatio?.raw ?? null,
                    shortPercentOfFloat: result.defaultKeyStatistics?.shortPercentOfFloat?.fmt ?? null,
                    priceToBook: result.defaultKeyStatistics?.priceToBook?.raw ?? null
                },
                financialHealth: {
                    profitMargin: result.financialData?.profitMargins?.fmt ?? null,
                    returnOnEquity: result.financialData?.returnOnEquity?.fmt ?? null,
                    totalDebt: result.financialData?.totalDebt?.raw ?? null
                },
                analystTargets: {
                    mean: result.financialData?.targetMeanPrice?.raw ?? null,
                    high: result.financialData?.targetHighPrice?.raw ?? null,
                    low: result.financialData?.targetLowPrice?.raw ?? null,
                    median: result.financialData?.targetMedianPrice?.raw ?? null,
                    consensusRecommendation: result.financialData?.recommendationKey ?? null
                },
                calendar: {
                    earningsDate: result.calendarEvents?.earnings?.earningsDate?.[0]?.fmt ?? null
                },
                upgradesDowngrades: (result.upgradeDowngradeHistory?.history || []).slice(0, 5).map(item => ({
                    firm: item.firm,
                    toGrade: item.toGrade,
                    fromGrade: item.fromGrade,
                    action: item.action
                }))
            };

            return new Response(JSON.stringify(payload), { headers: corsHeaders });
        } catch (err) {
            return new Response(JSON.stringify({ error: err.message }), {
                status: 500,
                headers: corsHeaders
            });
        }
    }
};