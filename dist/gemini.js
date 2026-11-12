function validateImageBytes(data, mimeType) {
    const valid = mimeType === "image/jpeg"
        ? data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
        : mimeType === "image/png"
            ? data.length > 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : mimeType === "image/webp"
                ? data.length > 12 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP"
                : false;
    if (!valid)
        throw new Error("Gemini returned image data that does not match its declared format.");
}
export async function editImage(image, mimeType, prompt, model) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey)
        throw new Error("Gemini is not configured. Set GEMINI_API_KEY on the backend.");
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
            contents: [{
                    parts: [
                        { text: prompt },
                        { inlineData: { mimeType, data: image.toString("base64") } },
                    ],
                }],
            generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        }),
    });
    const body = await response.json();
    if (!response.ok) {
        throw new Error(`Gemini request failed (${response.status}): ${body.error?.message || "Unknown provider error"}`);
    }
    const imagePart = body.candidates?.flatMap((candidate) => candidate.content?.parts ?? [])
        .find((part) => part.inlineData?.data && part.inlineData.mimeType);
    if (!imagePart?.inlineData?.data || !imagePart.inlineData.mimeType?.startsWith("image/")) {
        throw new Error("Gemini returned no edited image. Text-only responses are not considered successful.");
    }
    const result = Buffer.from(imagePart.inlineData.data, "base64");
    if (result.length === 0)
        throw new Error("Gemini returned an empty image.");
    validateImageBytes(result, imagePart.inlineData.mimeType);
    const data = result.toString("base64");
    result.fill(0);
    return { data, mimeType: imagePart.inlineData.mimeType };
}
