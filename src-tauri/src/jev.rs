//! TypeSafe Jev：对候选下一步做一次 typed choice，不生成正文。

use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

const JEV_MODEL: &str = "jev-latest";
const DEEPSEEK_MODEL: &str = "deepseek-chat";
const LAYA_DEFAULT: &str = "http://127.0.0.1:8100";

#[derive(Debug, Clone, serde::Deserialize)]
pub struct JevOption {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatus {
    pub jev: bool,
    pub laya: bool,
    pub laya_base: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JevDecision {
    pub choice: String,
    pub confidence: f64,
    pub continue_now: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    pub ok: bool,
    pub message: String,
    pub endpoint: String,
    pub latency_ms: u128,
}

pub fn probe(
    provider: Option<String>,
    api_key: Option<String>,
    base_url: Option<String>,
) -> ProbeReport {
    let started = std::time::Instant::now();
    let provider = normalize_provider(provider);
    let outcome = match provider.as_str() {
        "laya" => probe_laya(base_url),
        "deepseek" => probe_deepseek(api_key, base_url),
        _ => probe_jev(api_key, base_url),
    };
    let latency_ms = started.elapsed().as_millis();
    match outcome {
        Ok((endpoint, message)) => ProbeReport {
            ok: true,
            message,
            endpoint,
            latency_ms,
        },
        Err((endpoint, message)) => ProbeReport {
            ok: false,
            message,
            endpoint,
            latency_ms,
        },
    }
}

fn probe_laya(base_url: Option<String>) -> Result<(String, String), (String, String)> {
    let endpoint = laya_endpoint(base_url);
    let origin = endpoint.trim_end_matches("/v1/systemone").to_string();
    let health = format!("{origin}/health");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| (health.clone(), format!("无法创建客户端：{e}")))?;
    let response = client
        .get(&health)
        .send()
        .map_err(|e| (health.clone(), format!("无法连接：{e}")))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| (health.clone(), format!("读取响应失败：{e}")))?;
    if !status.is_success() {
        return Err((health, format!("HTTP {}", status.as_u16())));
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|_| (health.clone(), "响应不是 Laya 的 /health".into()))?;
    let alive = value.get("models").and_then(|v| v.as_array()).is_some()
        || value.get("loaded").is_some()
        || value.get("status").and_then(|v| v.as_str()) == Some("ok");
    if !alive {
        return Err((health, "已连接，但不是 Laya 服务".into()));
    }
    let loaded = value
        .get("loaded")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| "未报告模型".into());
    Ok((health, format!("服务可用 · {loaded}")))
}

fn probe_deepseek(
    api_key: Option<String>,
    base_url: Option<String>,
) -> Result<(String, String), (String, String)> {
    let key = resolve_key("deepseek", api_key).map_err(|e| (String::new(), e))?;
    let key = key.ok_or_else(|| (String::new(), "未配置 DeepSeek API Key".to_string()))?;
    let chat = service_endpoint(
        base_url,
        &["DEEPSEEK_BASE_URL"],
        "https://api.deepseek.com",
        "/chat/completions",
    );
    let endpoint = format!("{}/models", chat.trim_end_matches("/chat/completions"));
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("pi-auto")
        .build()
        .map_err(|e| (endpoint.clone(), format!("无法创建客户端：{e}")))?;
    let response = client
        .get(&endpoint)
        .bearer_auth(key)
        .send()
        .map_err(|e| (endpoint.clone(), format!("请求失败：{e}")))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| (endpoint.clone(), format!("读取响应失败：{e}")))?;
    if !status.is_success() {
        return Err((endpoint, format!("HTTP {}：{}", status.as_u16(), truncate(&text, 160))));
    }
    let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let count = value
        .get("data")
        .and_then(|v| v.as_array())
        .map(|items| items.len())
        .unwrap_or(0);
    Ok((endpoint, format!("密钥可用 · {count} 个模型")))
}

fn probe_jev(
    api_key: Option<String>,
    base_url: Option<String>,
) -> Result<(String, String), (String, String)> {
    let endpoint = service_endpoint(
        base_url.clone(),
        &["JEV_BASE_URL", "TYPESAFE_BASE_URL"],
        "https://api.typesafe.ai",
        "/v1/systemone",
    );
    match choose(
        Some("jev".into()),
        api_key,
        base_url,
        "连接检查。".into(),
        vec![
            JevOption {
                id: "a".into(),
                text: "是".into(),
            },
            JevOption {
                id: "b".into(),
                text: "否".into(),
            },
        ],
        Some("选 a。".into()),
        Some(false),
    ) {
        Ok(decision) => Ok((
            decision.endpoint.unwrap_or(endpoint),
            format!("密钥可用 · 返回 {}", decision.choice),
        )),
        Err(err) => Err((endpoint, err)),
    }
}

pub fn backend_status(laya_base: Option<String>) -> BackendStatus {
    let jev = std::env::var("TYPESAFE_API_KEY")
        .ok()
        .is_some_and(|key| !key.trim().is_empty());
    let laya_base = find_laya(laya_base);
    BackendStatus {
        jev,
        laya: laya_base.is_some(),
        laya_base,
    }
}

fn find_laya(preferred: Option<String>) -> Option<String> {
    let mut candidates = Vec::new();
    if let Some(base) = preferred.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        candidates.push(base);
    }
    if let Ok(base) = std::env::var("LAYA_BASE_URL") {
        let base = base.trim().to_string();
        if !base.is_empty() && !candidates.iter().any(|item| item == &base) {
            candidates.push(base);
        }
    }
    if !candidates.iter().any(|item| item == LAYA_DEFAULT) {
        candidates.push(LAYA_DEFAULT.into());
    }
    candidates.into_iter().find(|base| laya_alive(base))
}

fn laya_alive(base_url: &str) -> bool {
    let origin = laya_endpoint(Some(base_url.to_string()));
    let origin = origin.trim_end_matches("/v1/systemone");
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(700))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    let Ok(response) = client.get(format!("{origin}/health")).send() else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    let Ok(body) = response.text() else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(&body) else {
        return false;
    };
    value.get("models").and_then(|v| v.as_array()).is_some()
        || value.get("loaded").is_some()
        || value.get("status").and_then(|v| v.as_str()) == Some("ok")
}

pub fn choose(
    provider: Option<String>,
    api_key: Option<String>,
    base_url: Option<String>,
    state: String,
    options: Vec<JevOption>,
    instructions: Option<String>,
    include_stop: Option<bool>,
) -> Result<JevDecision, String> {
    let include_stop = include_stop.unwrap_or(true);
    let instructions = instructions.unwrap_or_else(|| {
        if include_stop {
            "现在应该做哪一项？如果都不该现在做，选 stop。".into()
        } else {
            "选最符合问题的一项。".into()
        }
    });
    let provider = normalize_provider(provider);
    let key = resolve_key(&provider, api_key)?;
    if options.is_empty() {
        return Err("没有可决策的下一步".into());
    }
    if options.len() > 6 {
        return Err("下一步过多".into());
    }
    for option in &options {
        let id = option.id.trim();
        if id.is_empty() || id == "stop" || id.len() > 16 {
            return Err(format!("无效选项 id：{id}"));
        }
    }
    if provider == "deepseek" {
        return choose_deepseek(key.as_deref().unwrap_or(""), base_url, &state, &options);
    }
    if provider == "laya" {
        return choose_laya(key.as_deref(), base_url, &state, &options, &instructions, include_stop);
    }
    let endpoint = service_endpoint(
        base_url,
        &["JEV_BASE_URL", "TYPESAFE_BASE_URL"],
        "https://api.typesafe.ai",
        "/v1/systemone",
    );
    let mut decision = choose_systemone(
        "Jev",
        &endpoint,
        JEV_MODEL,
        key.as_deref(),
        &state,
        &options,
        &instructions,
        include_stop,
    )?;
    decision.endpoint = Some(endpoint);
    Ok(decision)
}

fn choose_laya(
    key: Option<&str>,
    base_url: Option<String>,
    state: &str,
    options: &[JevOption],
    instructions: &str,
    include_stop: bool,
) -> Result<JevDecision, String> {
    let mut endpoints = Vec::new();
    let preferred = laya_endpoint(base_url);
    endpoints.push(preferred.clone());
    let fallback = format!("{LAYA_DEFAULT}/v1/systemone");
    if preferred != fallback {
        endpoints.push(fallback);
    }
    let mut last = "Laya 未响应".to_string();
    for endpoint in endpoints {
        match choose_systemone(
            "Laya",
            &endpoint,
            "multilingual",
            key,
            state,
            options,
            instructions,
            include_stop,
        ) {
            Ok(mut decision) => {
                decision.endpoint = Some(endpoint);
                return Ok(decision);
            }
            Err(err) => last = err,
        }
    }
    Err(last)
}

fn choose_systemone(
    label: &str,
    endpoint: &str,
    model: &str,
    key: Option<&str>,
    state: &str,
    options: &[JevOption],
    instructions: &str,
    include_stop: bool,
) -> Result<JevDecision, String> {
    let mut criteria = serde_json::Map::new();
    for option in options {
        criteria.insert(
            option.id.trim().to_string(),
            Value::String(truncate(&option.text, 240)),
        );
    }
    if include_stop {
        criteria.insert(
            "stop".into(),
            Value::String("没有值得现在继续的下一步，结束本轮".into()),
        );
    }
    let mut questions = serde_json::Map::new();
    questions.insert(
        "next".into(),
        json!({
            "type": "choice",
            "instructions": instructions,
            "criteria": criteria
        }),
    );
    if include_stop {
        questions.insert(
            "continue_now".into(),
            json!({
                "type": "noul",
                "instructions": "这些下一步里，是否有一条明确、范围合适、值得立刻做的？",
                "criteria": {
                    "true": "有一条具体、还没做完、值得马上做",
                    "false": "工作已足够，或建议含糊、越界、不该现在做"
                }
            }),
        );
    }
    let body = json!({
        "state": truncate(state, 6000),
        "model": model,
        "questions": questions
    });
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("pi-auto")
        .build()
        .map_err(|e| format!("创建 {label} 客户端失败：{e}"))?;
    let mut request = client.post(endpoint).json(&body);
    if let Some(key) = key {
        request = request.bearer_auth(key);
    }
    let response = request
        .send()
        .map_err(|e| format!("{label} 请求失败：{e}"))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("{label} 响应读取失败：{e}"))?;
    if !status.is_success() {
        return Err(format!(
            "{label} HTTP {}：{}",
            status.as_u16(),
            truncate(&text, 240)
        ));
    }
    parse_decision(&text).map_err(|e| format!("{label}：{e}"))
}

fn service_endpoint(
    base_url: Option<String>,
    env_names: &[&str],
    default_origin: &str,
    suffix: &str,
) -> String {
    let mut raw = base_url
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if raw.is_none() {
        for name in env_names {
            if let Ok(value) = std::env::var(name) {
                let value = value.trim().to_string();
                if !value.is_empty() {
                    raw = Some(value);
                    break;
                }
            }
        }
    }
    let raw = raw.unwrap_or_else(|| default_origin.into());
    let raw = raw.trim_end_matches('/');
    if raw.ends_with(suffix) {
        raw.to_string()
    } else {
        format!("{raw}{suffix}")
    }
}

fn laya_endpoint(base_url: Option<String>) -> String {
    service_endpoint(
        base_url,
        &["LAYA_BASE_URL"],
        LAYA_DEFAULT,
        "/v1/systemone",
    )
}

fn normalize_provider(provider: Option<String>) -> String {
    match provider.as_deref().map(str::trim) {
        Some("deepseek") => "deepseek".into(),
        Some("laya") => "laya".into(),
        _ => "jev".into(),
    }
}

fn resolve_key(provider: &str, passed: Option<String>) -> Result<Option<String>, String> {
    if let Some(key) = passed.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        return Ok(Some(key));
    }
    if provider == "laya" {
        return Ok(std::env::var("LAYA_API_KEY")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()));
    }
    let (env_name, label) = if provider == "deepseek" {
        ("DEEPSEEK_API_KEY", "DeepSeek")
    } else {
        ("TYPESAFE_API_KEY", "Jev")
    };
    std::env::var(env_name)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(Some)
        .ok_or_else(|| {
            format!("未配置 {label} API Key。请在系统菜单「密钥设置」中填写，或设置 {env_name}")
        })
}

fn choose_deepseek(
    key: &str,
    base_url: Option<String>,
    state: &str,
    options: &[JevOption],
) -> Result<JevDecision, String> {
    let allowed: Vec<String> = options.iter().map(|option| option.id.clone()).collect();
    let listed = options
        .iter()
        .map(|option| format!("{}: {}", option.id, truncate(&option.text, 240)))
        .collect::<Vec<_>>()
        .join("\n");
    let body = json!({
        "model": std::env::var("DEEPSEEK_MODEL").unwrap_or_else(|_| DEEPSEEK_MODEL.into()),
        "temperature": 0,
        "response_format": { "type": "json_object" },
        "messages": [
            {
                "role": "system",
                "content": "你是续跑决策器。只输出一个 JSON 对象，不要解释。字段：choice（必须是给定 id 或 stop）、confidence（0 到 1，对这个选择有多确定）、continueNow（0 到 1，是否值得立刻做）。没有明确、范围合适、还没做完的下一步时，choice 必须是 stop。"
            },
            {
                "role": "user",
                "content": format!("候选：\n{listed}\nstop: 没有值得现在继续的下一步\n\n{}", truncate(state, 6000))
            }
        ]
    });
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(45))
        .user_agent("pi-auto")
        .build()
        .map_err(|e| format!("创建 DeepSeek 客户端失败：{e}"))?;
    let endpoint = service_endpoint(
        base_url,
        &["DEEPSEEK_BASE_URL"],
        "https://api.deepseek.com",
        "/chat/completions",
    );
    let response = client
        .post(endpoint)
        .bearer_auth(key)
        .json(&body)
        .send()
        .map_err(|e| format!("DeepSeek 请求失败：{e}"))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("DeepSeek 响应读取失败：{e}"))?;
    if !status.is_success() {
        return Err(format!(
            "DeepSeek HTTP {}：{}",
            status.as_u16(),
            truncate(&text, 240)
        ));
    }
    parse_deepseek(&text, &allowed)
}

fn parse_deepseek(text: &str, allowed: &[String]) -> Result<JevDecision, String> {
    let value: Value = serde_json::from_str(text).map_err(|e| format!("DeepSeek JSON 无效：{e}"))?;
    let content = value
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let payload = extract_json(content);
    let decision: Value =
        serde_json::from_str(&payload).map_err(|e| format!("DeepSeek 决策不是 JSON：{e}"))?;
    let raw_choice = decision
        .get("choice")
        .and_then(|v| v.as_str())
        .unwrap_or("stop");
    let choice = normalize_choice(raw_choice, allowed);
    let confidence = clamp01(
        decision
            .get("confidence")
            .and_then(|v| v.as_f64())
            .unwrap_or(if choice == "stop" { 1.0 } else { 0.8 }),
    );
    let continue_now = clamp01(
        decision
            .get("continueNow")
            .or_else(|| decision.get("continue_now"))
            .and_then(|v| v.as_f64())
            .unwrap_or(if choice == "stop" { 0.0 } else { 0.8 }),
    );
    Ok(JevDecision {
        choice,
        confidence,
        continue_now,
        endpoint: None,
    })
}

fn normalize_choice(raw: &str, allowed: &[String]) -> String {
    let raw = raw.trim().trim_matches('"');
    if raw.eq_ignore_ascii_case("stop") || raw == "停止" || raw == "无" {
        return "stop".into();
    }
    if allowed.iter().any(|id| id == raw) {
        return raw.to_string();
    }
    if let Ok(index) = raw.trim_start_matches('s').trim_start_matches('S').parse::<usize>() {
        let id = format!("s{index}");
        if allowed.iter().any(|item| item == &id) {
            return id;
        }
    }
    "stop".into()
}

fn extract_json(text: &str) -> String {
    let start = text.find('{');
    let end = text.rfind('}');
    match (start, end) {
        (Some(start), Some(end)) if end > start => text[start..=end].to_string(),
        _ => text.trim().to_string(),
    }
}

fn clamp01(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}

fn parse_decision(text: &str) -> Result<JevDecision, String> {
    let value: Value = serde_json::from_str(text).map_err(|e| format!("Jev JSON 无效：{e}"))?;
    let answers = value.get("answers").ok_or("Jev 响应缺少 answers")?;
    let next = answers.get("next").ok_or("Jev 响应缺少 next")?;
    let choice = next
        .get("choice")
        .and_then(|v| v.as_str())
        .unwrap_or("stop")
        .to_string();
    let confidence = next
        .get("confidence")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let continue_now = answers
        .get("continue_now")
        .and_then(|v| v.get("noul"))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    Ok(JevDecision {
        choice,
        confidence,
        continue_now,
        endpoint: None,
    })
}

fn truncate(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max_chars).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::{laya_endpoint, normalize_choice, parse_decision, parse_deepseek};

    #[test]
    fn parses_choice_and_noul() {
        let raw = r#"{
            "model": "jev-1.13.0",
            "answers": {
                "next": { "type": "choice", "choice": "s2", "confidence": 0.72, "probabilities": { "s2": 0.8, "stop": 0.2 } },
                "continue_now": { "type": "noul", "noul": 0.81 }
            }
        }"#;
        let decision = parse_decision(raw).unwrap();
        assert_eq!(decision.choice, "s2");
        assert!((decision.confidence - 0.72).abs() < 0.001);
        assert!((decision.continue_now - 0.81).abs() < 0.001);
    }

    #[test]
    fn parses_deepseek_json_choice() {
        let raw = r#"{
            "choices": [{
                "message": {
                    "content": "```json\n{\"choice\":\"2\",\"confidence\":0.9,\"continueNow\":0.7}\n```"
                }
            }]
        }"#;
        let decision = parse_deepseek(raw, &["s1".into(), "s2".into()]).unwrap();
        assert_eq!(decision.choice, "s2");
        assert!((decision.confidence - 0.9).abs() < 0.001);
        assert!((decision.continue_now - 0.7).abs() < 0.001);
    }

    #[test]
    fn unknown_choice_stops() {
        assert_eq!(normalize_choice("做完了", &["s1".into()]), "stop");
    }

    #[test]
    fn laya_base_gets_systemone_path() {
        assert_eq!(
            laya_endpoint(Some("http://127.0.0.1:8000/".into())),
            "http://127.0.0.1:8000/v1/systemone"
        );
        assert_eq!(
            laya_endpoint(Some("http://127.0.0.1:8000/v1/systemone".into())),
            "http://127.0.0.1:8000/v1/systemone"
        );
    }
}
