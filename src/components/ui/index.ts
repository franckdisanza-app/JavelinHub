/**
 * Shared UI primitives.
 *
 * Small, unopinionated and composable on purpose — this is not a design
 * system, it is the handful of pieces every page in the marketplace needs.
 *
 * | Component            | Use it for                                          |
 * |----------------------|-----------------------------------------------------|
 * | `Button`             | anything that submits or toggles                    |
 * | `linkButtonClass()`  | a `<Link>` that should look like a button           |
 * | `Input` / `Textarea` | form controls; pass `invalid` to get the error state |
 * | `Label`              | a real `<label>`; always give it `htmlFor`          |
 * | `Field`              | label + control + hint + error, wired for a11y      |
 * | `fieldDescribedBy()` | builds the control's `aria-describedby`             |
 * | `Card` + parts       | a bordered surface with header/body/footer          |
 * | `Alert`              | form-level and flash messages                       |
 * | `Badge`              | short square status chips                           |
 * | `Select`             | a native select, styled to match `Input`            |
 * | `Stat` / `StatEmpty` | a measured number + its label (section 06's `.pb`)   |
 * | `Rating`             | a rating average, or why there is not one            |
 *
 * None of these carry `'use client'`, so they render in Server Components and
 * are equally usable inside a Client Component.
 *
 * Every colour, face and rule line here comes from a semantic token in
 * `globals.css`, which is generated from the JavelinHub brand guidelines v1.1
 * (`docs/brand-guidelines.html`). Five consequences worth knowing before
 * editing any of these files:
 *
 *   - No hex, ever. If a colour is missing, add a semantic token; do not inline
 *     a value.
 *   - No radius and no shadows. Section 06: there is no radius token because
 *     there is no radius, and depth is a rule line plus a change of ground.
 *   - No `dark:` variants and no `prefers-color-scheme`. The product ships one
 *     light theme; Ink is an accent surface, not an alternate palette.
 *   - No Tailwind default type steps. Section 04 publishes three scales —
 *     display 92/60/34/22, body 20/17/15, mono 16/13/12/11/10 — which share
 *     almost nothing with Tailwind's 12/14/16/18/…, so the default steps are
 *     off-scale by definition. Use the scale tokens instead: body-15, mono-12
 *     and friends, each named for the pixel value it produces so conformance
 *     is auditable from the class name. The lone exception is the field token,
 *     the 16px floor for anything the user types.
 *
 *     (Those token names are written unprefixed on purpose — see the next
 *     point. Spelling them as real class names here would compile them.)
 *   - Watch what you name in a comment. These files are scanned for class
 *     names, so writing a utility in prose compiles it into the shipped
 *     stylesheet — that is how a `box-shadow` rule got into a product whose
 *     brand forbids shadows. See the note at the top of `globals.css`.
 */

export { Alert, type AlertProps, type AlertTone } from './alert';
export { Badge, type BadgeProps, type BadgeTone } from './badge';
export { Button, linkButtonClass, type ButtonProps, type ButtonSize, type ButtonVariant } from './button';
export { Card, CardBody, CardFooter, CardHeader, type CardProps } from './card';
export { cn } from './cn';
export { Field, fieldDescribedBy, type FieldProps } from './field';
export { Input, Textarea, type InputProps, type TextareaProps } from './input';
export { Label, type LabelProps } from './label';
export { Select, type SelectProps } from './select';
export { Rating, Stat, StatEmpty } from './stat';
