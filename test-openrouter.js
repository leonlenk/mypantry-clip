const apiKey = "dummy-key";
fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "chrome-extension://recipe-ai",
        "X-Title": "Recipe AI"
    },
    body: JSON.stringify({
        model: "anthropic/claude-3-5-sonnet",
        messages: [{ role: "user", content: "hi" }]
    })
}).then(res => res.text()).then(txt => {
    console.log("With custom referer:", txt);
}).catch(console.error);

fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "X-Title": "Recipe AI"
    },
    body: JSON.stringify({
        model: "anthropic/claude-3-5-sonnet",
        messages: [{ role: "user", content: "hi" }]
    })
}).then(res => res.text()).then(txt => {
    console.log("Without origin/referer:", txt);
}).catch(console.error);
