import { builtin, choice, decide, match } from "../src/index.js";

const Greeting = choice("greeting", {
  instructions: "Is the user saying hello or goodbye?",
  options: { hello: "a greeting", goodbye: "a farewell" },
  examples: [
    ["hi there", "hello"], ["hello!", "hello"], ["good morning", "hello"], ["hey", "hello"],
    ["bye", "goodbye"], ["see you later", "goodbye"], ["good night", "goodbye"], ["farewell", "goodbye"],
  ],
  backends: [builtin()],
});

for (const text of ["hello world", "bye world", "banana"]) {
  const o = await decide(Greeting, text);
  const reply = match(o, {
    hello: () => "Hello, world!",
    goodbye: () => "Goodbye, world!",
    uncertain: () => "Hmm, not sure what you mean.",
  });
  console.log(`${text.padEnd(12)} → ${reply}  (${o.label} ${(o.confidence * 100).toFixed(0)}%)`);
}
