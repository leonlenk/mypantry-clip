fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer sk-or-v1-fake-token-1234567890`,
    },
    body: JSON.stringify({
        model: "anthropic/claude-3-5-sonnet",
        messages: [{ role: "user", content: "hi" }]
    })
}).then(res => res.text()).then(txt => {
    console.log("With fake formatted key:", txt);
}).catch(console.error);
