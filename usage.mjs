// Comate's cloud execute stream currently omits provider token counts. These
// estimates describe the client-visible context, not billing or hidden cloud
// prompts/compaction. Keep provenance beside the OpenAI-compatible counters.
const METHOD = "unicode-density-v1"
const IMAGE_TOKENS = 1024

function units(text) {
  let count = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    // Four ASCII characters or one BMP non-ASCII character per token;
    // astral characters reserve two tokens. This is not a model tokenizer.
    count += code <= 0x7f ? 1 : code <= 0xffff ? 4 : 8
  }
  return count
}

export function createUsageMeter(messages, tools, instructions, images = new Map()) {
  const transcript = messages.map(message => JSON.stringify(message)).join("\n")
  const imageCount = [...images.values()].reduce((sum, list) => sum + list.length, 0)
  const prompt = Math.ceil(units(instructions + "\n\nConversation transcript:\n" + transcript + "\n" + JSON.stringify(tools)) / 4) + imageCount * IMAGE_TOKENS
  let textUnits = 0, reasoningUnits = 0
  return {
    text(value) { textUnits += units(value) },
    reasoning(value) { reasoningUnits += units(value) },
    tool(call) { textUnits += units(JSON.stringify({ name: call.name, arguments: call.input })) },
    value() {
      const reasoning = Math.ceil(reasoningUnits / 4)
      const completion = Math.ceil(textUnits / 4) + reasoning
      return {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
        completion_tokens_details: { reasoning_tokens: reasoning },
        comate_usage: { source: "estimated", method: METHOD, scope: "client-visible-context", image_tokens: imageCount * IMAGE_TOKENS },
      }
    },
  }
}
