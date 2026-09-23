import { expect, test } from "bun:test";
import { chatGptModelFamilyMatches } from "../src/adapters/chatgpt-web/model-selection";

test.each([", 5 of 5.", "，5 of 5.", "、5件中5件目。", "، ٥ من ٥.", "; 5 sur 5.", ": 5 von 5."])("family confirmation reads localized announcement separators: %s", suffix => {
  const instructions = "左右の矢印キーでパワーを調整します。";
  for (const family of ["6", "5.6"] as const) {
    const description = `${family} Pro${suffix}`;
    expect(chatGptModelFamilyMatches([description, instructions], family, "max")).toBe(true);
    expect(chatGptModelFamilyMatches([description], family === "6" ? "5.6" : "6", "max")).toBe(false);
    expect(chatGptModelFamilyMatches([description], family, "xhigh")).toBe(false);
  }
  expect(chatGptModelFamilyMatches([`6 Pro${suffix}`, `5.6 Pro${suffix}`], "6", "max")).toBe(false);
  expect(chatGptModelFamilyMatches([`7 Pro${suffix}`], "6", "max")).toBe(false);
  expect(chatGptModelFamilyMatches([`6 Pro for better answers${suffix}`], "6", "max")).toBe(false);
  expect(chatGptModelFamilyMatches([`6 Pro-preview${suffix}`], "6", "max")).toBe(false);
  expect(chatGptModelFamilyMatches([`6 Pro (Preview)${suffix}`], "6", "max")).toBe(false);
});

test("Japanese lower-effort announcements preserve Latest staging semantics", () => {
  expect(chatGptModelFamilyMatches(["5.6 極高、5件中4件目。"], "6", "xhigh")).toBe(true);
  expect(chatGptModelFamilyMatches(["5.6 極高、5件中4件目。"], "6", "max")).toBe(false);
});

test("family confirmation separates Latest staging from the actual Pro response", () => {
  expect(chatGptModelFamilyMatches(["5.6 High, 3 of 5."], "5.6", "high")).toBe(true);
  expect(chatGptModelFamilyMatches(["5.6 Extra High, 4 of 5."], "6", "xhigh")).toBe(true);
  expect(chatGptModelFamilyMatches(["6 Pro, 5 of 5."], "6", "max")).toBe(true);
  expect(chatGptModelFamilyMatches(["GPT-5.6 Sol Pro, 5 of 5."], "5.6", "max")).toBe(true);
  for (const descriptions of [[], ["Try Pro for more reasoning"], ["5.6 High, 3 of 5."], ["5.6 Pro, 5 of 5."],
    ["7 Pro, 5 of 5."], ["6 Sol Pro, 5 of 5."], ["6 Pro, 5 of 5.", "5.6 Pro, 5 of 5."], ["6 Pro for better answers"]]) {
    expect(chatGptModelFamilyMatches(descriptions, "6", "max")).toBe(false);
  }
  expect(chatGptModelFamilyMatches(["6 Pro, 5 of 5."], "5.6", "max")).toBe(false);
  expect(chatGptModelFamilyMatches(["6 Pro, 5 of 5."], "6", "xhigh")).toBe(false);
});
