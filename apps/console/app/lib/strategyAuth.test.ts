import { afterEach, describe, expect, it } from "vitest";
import { authorizeSignalConsumer, authorizeSignalProducer } from "./strategyAuth";

const URL_LOCAL = "http://127.0.0.1:18270/api/strategy/signal";
const URL_REMOTE = "http://10.0.0.8:18270/api/strategy/signal";

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { method: "POST", headers });
}

afterEach(() => { delete process.env.STRATEGY_SIGNAL_TOKEN; });

describe("策略接口访问控制", () => {
  it("默认只放行回环地址", () => {
    expect(authorizeSignalProducer(req(URL_LOCAL)).ok).toBe(true);
    const remote = authorizeSignalProducer(req(URL_REMOTE));
    expect(remote.ok).toBe(false);
    if (!remote.ok) expect(remote.status).toBe(403);
  });

  it("设置 token 后必须带对应请求头", () => {
    process.env.STRATEGY_SIGNAL_TOKEN = "s3cret";
    const missing = authorizeSignalProducer(req(URL_LOCAL));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(401);

    expect(authorizeSignalProducer(req(URL_LOCAL, { "x-strategy-token": "s3cret" })).ok).toBe(true);
    expect(authorizeSignalProducer(req(URL_LOCAL, { authorization: "Bearer s3cret" })).ok).toBe(true);
    expect(authorizeSignalProducer(req(URL_LOCAL, { "x-strategy-token": "wrong" })).ok).toBe(false);
  });

  it("浏览器消费通道不校验 token", () => {
    process.env.STRATEGY_SIGNAL_TOKEN = "s3cret";
    expect(authorizeSignalConsumer(req(URL_LOCAL)).ok).toBe(true);
    expect(authorizeSignalConsumer(req(URL_REMOTE)).ok).toBe(false);
  });
});
