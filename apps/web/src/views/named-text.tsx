import { Fragment } from "react"

// Private-use characters never appear in names or descriptions.
const open = "\u{E000}"
const close = "\u{E001}"

/** Text built by a describer, with every Station, Line, Train and Junction
 * name it looks up set in bold so names stand out from the sentence. */
export function NamedText({
  describe,
  name,
}: {
  describe: (name: (id: string) => string) => string
  name: (id: string) => string
}) {
  const [lead, ...rest] = describe((id) => `${open}${name(id)}${close}`).split(
    open
  )
  return (
    <>
      {lead}
      {rest.map((part, index) => {
        const [named, after = ""] = part.split(close)
        return (
          <Fragment key={index}>
            <strong className="named">{named}</strong>
            {after}
          </Fragment>
        )
      })}
    </>
  )
}
