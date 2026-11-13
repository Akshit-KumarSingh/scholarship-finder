import { z } from "zod";

/*
 * Input checking for the API and for the arguments the LLM sends to
 * check_eligibility. Same rules in both places, so a bad value can't sneak in
 * through the agent either.
 *
 * Numbers sent as strings ("4") are converted to numbers, because HTML inputs
 * and LLMs both produce strings sometimes. Empty strings mean "not given".
 */

const blank = (v) => (v === "" || v === null ? undefined : v);
const upper = (v) => (typeof v === "string" ? v.trim().toUpperCase() : v);

const optionalNumber = (label, min, max) =>
  z.preprocess(
    blank,
    z.coerce
      .number({ invalid_type_error: `${label} must be a number` })
      .min(min, `${label} must be at least ${min}`)
      .max(max, `${label} must be at most ${max}`)
      .optional(),
  );

const optionalEnum = (values) =>
  z.preprocess((v) => blank(upper(v)), z.enum(values).optional());

export const CATEGORIES = ["GENERAL", "OBC", "SC", "ST", "EWS", "MINORITY"];

export const ProfileSchema = z.object({
  income: z.preprocess(
    blank,
    z.coerce
      .number({
        required_error: "income is required",
        invalid_type_error: "income must be a number (rupees)",
      })
      .min(0, "income cannot be negative"),
  ),
  category: z.preprocess(
    upper,
    z.enum(CATEGORIES, {
      errorMap: () => ({ message: `category must be one of ${CATEGORIES.join(", ")}` }),
    }),
  ),
  state: z.preprocess((v) => blank(upper(v)), z.string().max(40).optional()),
  course_level: optionalEnum(["UG", "PG", "DIPLOMA", "SCHOOL"]),
  year_of_study: optionalNumber("year_of_study", 1, 10),
  gender: optionalEnum(["MALE", "FEMALE", "OTHER"]),
  marks_pct: optionalNumber("marks_pct", 0, 100),
  disability: z.preprocess(
    (v) => (v === "true" ? true : v === "false" ? false : blank(v)),
    z.boolean().optional(),
  ),
});

export const ChatSchema = z.object({
  message: z
    .string({ required_error: "message is required" })
    .trim()
    .min(1, "message is required")
    .max(2000, "message is too long (2000 characters max)"),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(8000),
      }),
    )
    .max(30)
    .default([]),
  profile: ProfileSchema.nullish(),
});

/** Turn a zod error into one readable line for a 400 response. */
export function describeError(err) {
  return err.issues
    .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ");
}
