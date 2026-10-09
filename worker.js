import { env } from "cloudflare:workers";

const GKEY = env[`GEMINI_KEY`];
const FKEY = env[`FINNHUB_KEY`];
const AKEY = env[`ALPHA_KEY`];
const TKEY = env[`TWELVE_KEY`];
const RKEY = env[`RAPID_KEY`];
const GISTKEY = env[`GIST_KEY`];
const GITRKEY = env[`GIT_KEY`];

// Global session cache across Cloudflare Worker invocations
let cachedCookie = null;
let cachedCrumb = null;

async function getYahooCrumb(headers) {

    if (cachedCookie && cachedCrumb) {
        return { cookie: cachedCookie, crumb: cachedCrumb };
    }

    try {
        // Step 1: Hit fc.yahoo.com to extract session cookie
        const fcRes = await fetch("https://fc.yahoo.com", {
            headers: { ...headers },
            redirect: "manual"
        });

        const setCookie = fcRes.headers.get("set-cookie");
        if (setCookie) {
            cachedCookie = setCookie.split(";")[0];
        }

        // Step 2: Request the dynamic authorization crumb
        const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
            headers: {
                ...headers,
                "Cookie": cachedCookie || ""
            }
        });

        if (crumbRes.ok) {
            cachedCrumb = (await crumbRes.text()).trim();
        }

        return { cookie: cachedCookie, crumb: cachedCrumb };
    } catch (e) {
        return { cookie: null, crumb: null };
    }
}

export default {
    async fetch(request) {
        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "86400",
        };

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        const url = new URL(request.url);
        let symbol = (url.searchParams.get("symbol") || url.searchParams.get("ticker") || "").trim().toUpperCase();

        if (!symbol && request.method === "POST") {
            try {
                const body = await request.json();
                symbol = (body.symbol || body.ticker || "").trim().toUpperCase();
            } catch (e) { }
        }

        if (!symbol) {
            return new Response(
                JSON.stringify({ error: "Missing required 'symbol' or 'ticker' parameter." }),
                {
                    status: 400,
                    headers: {
                        ...corsHeaders,
                        "Content-Type": "application/json",
                    },
                }
            );
        }

        const baseHeaders = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.9",
        };

        try {
            // 1. Fetch real-time chart data (works without crumb)
            const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
            const chartPromise = fetch(chartUrl, { headers: baseHeaders });

            // 2. Fetch authenticated cookie and crumb for QuoteSummary
            const { cookie, crumb } = await getYahooCrumb(baseHeaders);

            const modules = [
                "price",
                "summaryDetail",
                "financialData",
                "defaultKeyStatistics",
                "recommendationTrend",
                "upgradeDowngradeHistory",
                "earningsHistory",
                "calendarEvents",
                "assetProfile"
            ].join(",");

            let summaryUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`;
            if (crumb) {
                summaryUrl += `&crumb=${encodeURIComponent(crumb)}`;
            }

            const summaryHeaders = {
                ...baseHeaders,
                ...(cookie ? { "Cookie": cookie } : {})
            };

            const [chartRes, summaryRes] = await Promise.all([
                chartPromise,
                fetch(summaryUrl, { headers: summaryHeaders })
            ]);

            let chartData = null;
            if (chartRes.ok) {
                const chartJson = await chartRes.json();
                chartData = chartJson.chart?.result?.[0]?.meta || null;
            }

            let summaryData = {};
            if (summaryRes.ok) {
                const sumJson = await summaryRes.json();
                summaryData = sumJson.quoteSummary?.result?.[0] || {};
            } else {
                // If cached crumb expired, invalidate cache so the next call refreshes it
                cachedCookie = null;
                cachedCrumb = null;
            }

            const p = summaryData.price || {};
            const sd = summaryData.summaryDetail || {};
            const fd = summaryData.financialData || {};
            const ks = summaryData.defaultKeyStatistics || {};
            const ap = summaryData.assetProfile || {};

            const responsePayload = {
                symbol: symbol,
                companyName: p.longName || p.shortName || chartData?.shortName || symbol,
                currency: p.currency || chartData?.currency || "USD",
                exchange: p.exchangeName || chartData?.exchangeName || null,

                // --- 1. Real-Time Price & Market Data ---
                price: {
                    current: p.regularMarketPrice?.raw ?? chartData?.regularMarketPrice ?? null,
                    previousClose: p.regularMarketPreviousClose?.raw ?? chartData?.chartPreviousClose ?? null,
                    open: p.regularMarketOpen?.raw ?? null,
                    dayHigh: p.regularMarketDayHigh?.raw ?? chartData?.regularMarketDayHigh ?? null,
                    dayLow: p.regularMarketDayLow?.raw ?? chartData?.regularMarketDayLow ?? null,
                    dayChange: p.regularMarketChange?.raw ?? (chartData ? (chartData.regularMarketPrice - chartData.chartPreviousClose) : null),
                    dayChangePercent: p.regularMarketChangePercent?.raw ?? (chartData ? ((chartData.regularMarketPrice - chartData.chartPreviousClose) / chartData.chartPreviousClose) * 100 : null),
                    volume: p.regularMarketVolume?.raw ?? chartData?.regularMarketVolume ?? null,
                    avgVolume: sd.averageVolume?.raw ?? null,
                    fiftyTwoWeekHigh: sd.fiftyTwoWeekHigh?.raw ?? null,
                    fiftyTwoWeekLow: sd.fiftyTwoWeekLow?.raw ?? null,
                    marketCap: p.marketCap?.raw ?? null,
                },

                // --- 2. Analyst Price Targets ---
                analystTargets: {
                    mean: fd.targetMeanPrice?.raw ?? null,
                    high: fd.targetHighPrice?.raw ?? null,
                    low: fd.targetLowPrice?.raw ?? null,
                    median: fd.targetMedianPrice?.raw ?? null,
                    numberOfAnalysts: fd.numberOfAnalystOpinions?.raw ?? 0,
                    consensusRecommendation: fd.recommendationKey ?? null,
                    recommendationScore: fd.recommendationMean?.raw ?? null,
                },

                // --- 3. Recommendation Trend History ---
                recommendationTrends: summaryData.recommendationTrend?.trend || [],

                // --- 4. Upgrades & Downgrades History ---
                upgradesDowngrades: (summaryData.upgradeDowngradeHistory?.history || []).slice(0, 10).map(u => ({
                    date: u.epochGradeDate ? new Date(u.epochGradeDate * 1000).toISOString().split('T')[0] : null,
                    firm: u.firm,
                    toGrade: u.toGrade,
                    fromGrade: u.fromGrade,
                    action: u.action,
                })),

                // --- 5. Valuation Multiples & Key Statistics ---
                valuation: {
                    peTrailing: sd.trailingPE?.raw ?? null,
                    peForward: sd.forwardPE?.raw ?? null,
                    pegRatio: ks.pegRatio?.raw ?? null,
                    priceToBook: ks.priceToBook?.raw ?? null,
                    enterpriseValue: ks.enterpriseValue?.raw ?? null,
                    evToEbitda: ks.enterpriseToEbitda?.raw ?? null,
                    beta: sd.beta?.raw ?? null,
                    shortPercentOfFloat: ks.shortPercentOfFloat?.raw ? (ks.shortPercentOfFloat.raw * 100).toFixed(2) + "%" : null,
                    sharesOutstanding: ks.sharesOutstanding?.raw ?? null,
                },

                // --- 6. Financial Health & Margins ---
                financialHealth: {
                    profitMargin: fd.profitMargins?.raw ? (fd.profitMargins.raw * 100).toFixed(2) + "%" : null,
                    operatingMargin: fd.operatingMargins?.raw ? (fd.operatingMargins.raw * 100).toFixed(2) + "%" : null,
                    returnOnEquity: fd.returnOnEquity?.raw ? (fd.returnOnEquity.raw * 100).toFixed(2) + "%" : null,
                    totalRevenue: fd.totalRevenue?.raw ?? null,
                    totalDebt: fd.totalDebt?.raw ?? null,
                    totalCash: fd.totalCash?.raw ?? null,
                    debtToEquity: fd.debtToEquity?.raw ?? null,
                },

                // --- 7. Earnings History ---
                earningsHistory: (summaryData.earningsHistory?.history || []).map(eh => ({
                    quarter: eh.quarter?.fmt,
                    epsActual: eh.epsActual?.raw,
                    epsEstimate: eh.epsEstimate?.raw,
                    epsDifference: eh.epsDifference?.raw,
                    surprisePercent: eh.surprisePercent?.raw ? (eh.surprisePercent.raw * 100).toFixed(2) + "%" : null,
                })),

                // --- 8. Calendar Events ---
                calendar: {
                    earningsDate: summaryData.calendarEvents?.earnings?.earningsDate?.[0]?.fmt ?? null,
                    exDividendDate: summaryData.calendarEvents?.exDividendDate?.fmt ?? null,
                    dividendRate: sd.dividendRate?.raw ?? 0,
                    dividendYield: sd.dividendYield?.raw ? (sd.dividendYield.raw * 100).toFixed(2) + "%" : "0%",
                },

                // --- 9. Company Profile ---
                profile: {
                    sector: ap.sector || null,
                    industry: ap.industry || null,
                    website: ap.website || null,
                    description: ap.longBusinessSummary || null,
                },

                timestamp: new Date().toISOString()
            };

            return new Response(JSON.stringify(responsePayload, null, 2), {
                status: 200,
                headers: {
                    ...corsHeaders,
                    "Content-Type": "application/json",
                },
            });
        } catch (err) {
            return new Response(
                JSON.stringify({ error: err.message, symbol }),
                {
                    status: 500,
                    headers: {
                        ...corsHeaders,
                        "Content-Type": "application/json",
                    },
                }
            );
        }
    },
};