//! TypeSafe Jev：对候选下一步做一次 typed choice，不生成正文。

use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

const ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";
const MODEL: &str = "jev-latest";

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
    api_key: Option<String>,
    state: String,
    options: Vec<JevOption>,
) -> Result<JevDecision, String> {
    let key = resolve_key(api_key)?;
    if options.is_empty() {
        return Err("没有可决策的下一步".into());
    }
    if options.len() > 6 {
        return Err("下一步过多".into());
    }
    let mut criteria = serde_json::Map::new();
    for option in &options {
        let id = option.id.trim();
        if id.is_empty() || id == "stop" || id.len() > 16 {
            return Err(format!("无效选项 id：{id}"));
        }
        criteria.insert(id.to_string(), Value::String(truncate(&option.text, 240)));
    }
    criteria.insert(
        "stop".into(),
        Value::String("没有值得现在继续的下一步，结束本轮".into()),
    );
    let body = json!({
        "state": truncate(&state, 6000),
        "model": MODEL,
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
        .map_err(|e| format!("创建 Jev 客户端失败：{e}"))?;
    let response = client
        .post(ENDPOINT)
        .bearer_auth(key)
        .json(&body)
        .send()
        .map_err(|e| format!("Jev 请求失败：{e}"))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Jev 响应读取失败：{e}"))?;
    if !status.is_success() {
        return Err(format!(
            "Jev HTTP {}：{}",
            status.as_u16(),
            truncate(&text, 240)
        ));
    }
    parse_decision(&text)
}

fn resolve_key(passed: Option<String>) -> Result<String, String> {
    if let Some(key) = passed.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        return Ok(key);
    }
    std::env::var("TYPESAFE_API_KEY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "未配置 Jev API Key。请填写，或设置 TYPESAFE_API_KEY".to_string())
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
    use super::parse_decision;

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
}
