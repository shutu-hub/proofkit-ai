import type { z } from "@proofkit/runner";
import type { TestScope } from "@proofkit/contracts";

type InputShape = TestScope["capabilities"]["items"][number]["inputShape"];

/** Bounded structural hints, not JSON Schema or a second validator. No parse/default/refinement callbacks run. */
export function describeInputShape(schema: z.ZodTypeAny): InputShape {
  const limitations = new Set<string>(["Runtime Zod validation remains authoritative; constraints and transformations are not fully described"]);
  const active = new Set<object>();
  let remaining = 100;
  let partial = false;
  const omitted = (reason: string): Record<string, unknown> => {
    partial = true;
    limitations.add(reason);
    return { kind: "unavailable" };
  };
  const visit = (value: z.ZodTypeAny, depth: number): Record<string, unknown> => {
    if (depth > 6 || remaining-- <= 0) return omitted("Input shape exceeded the depth or node limit");
    if (!value?._def || active.has(value)) return omitted("Opaque or recursive input shape requires inspecting the connector");
    active.add(value);
    try {
      const def = value._def as any;
      switch (def.typeName) {
        case "ZodOptional": return { ...visit(def.innerType, depth + 1), optional: true };
        case "ZodDefault": return { ...visit(def.innerType, depth + 1), optional: true, defaultOmitted: true };
        case "ZodNullable": return { ...visit(def.innerType, depth + 1), nullable: true };
        case "ZodEffects":
          partial = true;
          limitations.add("Refinement, preprocess and transform callbacks are omitted");
          return { ...visit(def.schema, depth + 1), runtimeEffect: true };
        case "ZodObject": {
          const shape = def.shape() as Record<string, z.ZodTypeAny>;
          const properties: Record<string, unknown> = Object.create(null);
          for (const [name, child] of Object.entries(shape)) {
            if (remaining <= 0) { omitted("Input shape exceeded the depth or node limit"); break; }
            properties[name] = visit(child, depth + 1);
          }
          return { kind: "object", properties };
        }
        case "ZodArray": return { kind: "array", items: visit(def.type, depth + 1) };
        case "ZodRecord": return { kind: "record", values: visit(def.valueType, depth + 1) };
        case "ZodUnion":
        case "ZodDiscriminatedUnion": {
          const options = [...def.options] as z.ZodTypeAny[];
          if (options.length > 10) omitted("Union branches are capped at 10");
          return { kind: "union", variants: options.slice(0, 10).map((child) => visit(child, depth + 1)) };
        }
        case "ZodEnum": {
          if (def.values.length > 20) omitted("Enum values are capped at 20");
          const values = def.values.slice(0, 20) as string[];
          if (values.some((item) => item.length > 128)) return omitted("Enum contains values exceeding the 128-character limit; exact values require inspecting the connector");
          return { kind: "enum", values };
        }
        case "ZodLiteral": {
          if (typeof def.value === "string") return def.value.length <= 128 ? { kind: "literal", value: def.value } : omitted("Literal exceeds the 128-character limit; exact value requires inspecting the connector");
          if (def.value === null || typeof def.value === "boolean" || (typeof def.value === "number" && Number.isFinite(def.value))) return { kind: "literal", value: def.value };
          return omitted("Literal is not a JSON primitive; inspect the connector for its runtime type");
        }
        case "ZodString": return { kind: "string" };
        case "ZodNumber": return { kind: "number" };
        case "ZodBoolean": return { kind: "boolean" };
        case "ZodNull": return { kind: "null" };
        case "ZodUnknown": return { kind: "unknown" };
        case "ZodAny": return { kind: "any" };
        default: return omitted(`Input type ${String(def.typeName).slice(0, 60)} is not described`);
      }
    } finally {
      active.delete(value);
    }
  };
  try {
    const hint = visit(schema, 0);
    if (JSON.stringify(hint).length > 6_000) return { partial: true, limitations: [...limitations, "Input shape exceeded the 6000-character output limit"] };
    return { hint, partial, limitations: [...limitations] };
  } catch {
    return { partial: true, limitations: [...limitations, "Input shape could not be inspected; read the trusted connector source"] };
  }
}
