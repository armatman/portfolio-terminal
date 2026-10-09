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
                const geminiKey = env.GEMINI_KEY || env.GEMINI_API_KEY;
                const body = await request.json();
                const model = body.model || "gemini-1.5-flash";
                const prompt = body.prompt;

                const res = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            contents: [{ parts: [{ text: prompt }] }]
                        })
                    }
                );
                const data = await res.json();
                return new Response(JSON.stringify(data), { headers: corsHeaders });
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

            // Existing Yahoo Finance scraping/proxy logic:
            const yahooUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=price,summaryDetail,defaultKeyStatistics,financialData,recommendationTrend,upgradeDowngradeHistory,calendarEvents`;
            const response = await fetch(yahooUrl, {
                headers: { "User-Agent": "Mozilla/5.0" }
            });

            if (!response.ok) {
                throw new Error(`Yahoo returned HTTP ${response.status}`);
            }

            const raw = await response.json();
            const result = raw.quoteSummary?.result?.[0] || {};

            // Normalized response object for the app
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