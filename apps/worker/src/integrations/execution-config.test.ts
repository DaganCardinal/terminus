import { describe, expect, it } from "vitest"
import { stationMaxRetries } from "./execution-config"

describe("Station retry configuration", () => {
  it("accepts the default, custom and zero allowances", () => {
    expect(stationMaxRetries({})).toBe(3)
    expect(stationMaxRetries({ STATION_MAX_RETRIES: "3" })).toBe(3)
    expect(stationMaxRetries({ STATION_MAX_RETRIES: "5" })).toBe(5)
    expect(stationMaxRetries({ STATION_MAX_RETRIES: "0" })).toBe(0)
  })
  it.each(["-1", "1.5", "invalid", "Infinity"])(
    "rejects %s instead of permitting unbounded retries",
    (value) => {
      expect(() => stationMaxRetries({ STATION_MAX_RETRIES: value })).toThrow()
    }
  )
})
