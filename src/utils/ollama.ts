const OLLAMA_URL =
    'http://mp2i-ollama:11434/api/generate';

export interface OllamaOptions {
    num_ctx?: number;
    temperature?: number;
}

interface OllamaResponse {
    response?: string;
}

export async function ollamaGenerate(
    model: string,
    system: string,
    prompt: string,
    options: OllamaOptions = {}
): Promise<string> {
    const response = await fetch(
        OLLAMA_URL,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model,
                system,
                prompt,
                stream: false,
                options: {
                    num_ctx:
                        options.num_ctx ?? 2048,
                    temperature:
                        options.temperature ?? 0.1,
                },
            }),
        }
    );

    if (!response.ok) {
        const errorText =
            await response.text();

        throw new Error(
            `Ollama: failed [HTTP ${response.status}]: ${errorText}`
        );
    }

    const data =
        (await response.json()) as OllamaResponse;

    if (
        typeof data.response !== 'string' ||
        data.response.trim().length === 0
    ) {
        throw new Error(
            'Ollama: empty response.'
        );
    }

    return data.response
        .trim()
        .replace(
            /^```(?:latex)?\s*/i,
            ''
        )
        .replace(
            /\s*```$/i,
            ''
        )
        .trim();
}