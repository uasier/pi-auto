//! TypeSafe Jev：对候选下一步做一次 typed choice，不生成正文。

use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

const JEV_ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL: &str = "jev-latest";
const DEEPSEEK_ENDPOINT: &str = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL: &str = "deepseek-chat";

#[derive(Debug, Clone, serde::Deserialize)]
pub struct JevOption {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JevDecision {
    pub choice: String,
    pub confidence: f64,
    pub continue_now: f64,
}

pub fn choose(
    provider: Option<String>,
    api_key: Option<String>,
    base_url: Option<String>,
    state: String,
    options: Vec<JevOption>,
) -> Result<JevDecision, String> {
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
        return choose_deepseek(key.as_deref().unwrap_or(""), &state, &options);
    }
    if provider == "laya" {
        return choose_systemone(
            "Laya",
            &laya_endpoint(base_url),
            "laya",
            key.as_deref(),
            &state,
            &options,
        );
    }
    choose_systemone("Jev", JEV_ENDPOINT, JEV_MODEL, key.as_deref(), &state, &options)
}

fn choose_systemone(
    label: &str,
    endpoint: &str,
    model: &str,
    key: Option<&str>,
    state: &str,
    options: &[JevOption],
) -> Result<JevDecision, String> {
    let mut criteria = serde_json::Map::new();
    for option in options {
        criteria.insert(
            option.id.trim().to_string(),
            Value::String(truncate(&option.text, 240)),
        );
    }
    criteria.insert(
        "stop".into(),
        Value::String("没有值得现在继续的下一步，结束本轮".into()),
    );
    let body = json!({
        "state": truncate(state, 6000),
        "model": model,
        "questions": {
            "next": {
                "type": "choice",
                "instructions": "现在应该做哪一项？如果都不该现在做，选 stop。",
                "criteria": criteria
            },
            "continue_now": {
                "type": "noul",
                "instructions": "这些下一步里，是否有一条明确、范围合适、值得立刻做的？",
                "criteria": {
                    "true": "有一条具体、还没做完、值得马上做",
                    "false": "工作已足够，或建议含糊、越界、不该现在做"
                }
            }
        }
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

fn laya_endpoint(base_url: Option<String>) -> String {
    let raw = base_url
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            std::env::var("LAYA_BASE_URL")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "http://127.0.0.1:8000".into());
    let raw = raw.trim_end_matches('/');
    if raw.ends_with("/v1/systemone") {
        raw.to_string()
    } else {
        format!("{raw}/v1/systemone")
    }
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
        .ok_or_else(|| format!("未配置 {label} API Key。请填写，或设置 {env_name}"))
}

fn choose_deepseek(key: &str, state: &str, options: &[JevOption]) -> Result<JevDecision, String> {
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
    let response = client
        .post(DEEPSEEK_ENDPOINT)
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
