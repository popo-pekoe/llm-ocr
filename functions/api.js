import { GoogleGenAI } from "@google/genai";

export async function onRequestPost(context) {
  try {
    // フロントエンド（HTML）から送られてきたAIへの質問を受け取る
    const { prompt } = await context.request.json();
    
    // 先ほど管理画面で設定した「安全な環境変数」をここで呼び出す（ブラウザからは絶対に見えません）
    const apiKey = context.env.GEMINI_API_KEY;
    
    // Gemini APIの初期化と呼び出し
    const ai = new GoogleGenAI({ apiKey: apiKey });
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });
    
    // AIの返答だけをHTML側に送り返す
    return new Response(JSON.stringify({ text: response.text }), {
      headers: { "Content-Type": "application/json" }
    });
    
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}