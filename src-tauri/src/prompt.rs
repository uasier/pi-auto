use super::{resolve_key, service_endpoint, truncate, DEEPSEEK_MODEL};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

pub fn refine_prompt(
    api_key: Option<String>,
    base_url: Option<String>,
    text: String,
    context: Option<String>,
) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("没有可处理的输入".into());
    }
    let content = deepseek_chat(
        api_key,
        base_url,
        "你把用户的本地请求改写成一条给编程助手的问题。结合会话上下文补上目标、范围和完成标准，但不要改成上下文里另一个无关任务。原话已经清楚时只做少量整理。用用户的语言。只输出改写后的问题，不要解释，不要加标题。",
        &complete_user_message(&text, context.as_deref()),
        false,
        0.2,
    )?;
    if content.is_empty() {
        return Err("DeepSeek 没有返回优化后的问题".into());
    }
    Ok(content)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteResult {
    pub intent: String,
    pub options: Vec<String>,
}

pub fn complete_options(
    api_key: Option<String>,
    base_url: Option<String>,
    text: String,
    context: Option<String>,
) -> Result<CompleteResult, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("没有可补全的输入".into());
    }
    let content = deepseek_chat(
        api_key,
        base_url,
        "先根据当前输入和会话上下文揣测用户此刻要让助手做的一件事。上一轮对话、报错、文件和目录比残缺输入更重要。不要猜成无关任务。然后只围绕这一个意图给出 3 个不同的下一步动作，给助手直接执行，不是向用户提问。每条用祈使句，写清要看的文件、要改的行为或要验证的结果。不要以问号结尾，不要写成是否、能不能、什么原因这类问题。intent 用一句话写出揣测到的意图，也不要写成问句。用用户的语言。只输出 JSON：{\"intent\":\"...\",\"options\":[\"...\",\"...\",\"...\"]}。",
        &complete_user_message(&text, context.as_deref()),
        true,
        0.2,
    )?;
    parse_complete_options(&content)
}

fn deepseek_chat(
    api_key: Option<String>,
    base_url: Option<String>,
    system: &str,
    user: &str,
    json_mode: bool,
    temperature: f64,
) -> Result<String, String> {
    let key = resolve_key("deepseek", api_key)?.unwrap_or_default();
    if key.is_empty() {
        return Err("未配置 DeepSeek API Key。请在系统菜单「密钥设置」中填写".into());
    }
    let endpoint = service_endpoint(
        base_url,
        &["DEEPSEEK_BASE_URL"],
        "https://api.deepseek.com",
        "/chat/completions",
    );
    let mut body = json!({
        "model": std::env::var("DEEPSEEK_MODEL").unwrap_or_else(|_| DEEPSEEK_MODEL.into()),
        "temperature": temperature,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ]
    });
    if json_mode {
        body["response_format"] = json!({ "type": "json_object" });
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(45))
        .user_agent("pi-auto")
        .build()
        .map_err(|e| format!("创建 DeepSeek 客户端失败：{e}"))?;
    let response = client
        .post(&endpoint)
        .bearer_auth(key)
        .json(&body)
        .send()
        .map_err(|e| format!("DeepSeek 请求失败：{e}"))?;
    let status = response.status();
    let raw = response
        .text()
        .map_err(|e| format!("DeepSeek 响应读取失败：{e}"))?;
    if !status.is_success() {
        return Err(format!("DeepSeek HTTP {}：{}", status.as_u16(), truncate(&raw, 240)));
    }
    let value: Value = serde_json::from_str(&raw).map_err(|e| format!("DeepSeek JSON 无效：{e}"))?;
    Ok(strip_fence(
        value
            .pointer("/choices/0/message/content")
            .and_then(|v| v.as_str())
            .unwrap_or(""),
    ))
}

fn complete_user_message(text: &str, context: Option<&str>) -> String {
    let context = context.unwrap_or("").trim();
    if context.is_empty() {
        return format!("当前输入：\n{}", truncate(text, 4000));
    }
    format!(
        "会话上下文：\n{}\n\n当前输入：\n{}",
        truncate(context, 5000),
        truncate(text, 2000)
    )
}

fn parse_complete_options(content: &str) -> Result<CompleteResult, String> {
    let payload = strip_fence(content);
    let value: Value = serde_json::from_str(&payload).map_err(|e| format!("补全结果不是 JSON：{e}"))?;
    let items = value
        .get("options")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "补全结果缺少 options".to_string())?;
    let mut options = Vec::new();
    for item in items {
        let text = format_complete_option(item);
        if text.is_empty() || options.iter().any(|have: &String| have == &text) {
            continue;
        }
        options.push(text);
        if options.len() == 3 {
            break;
        }
    }
    if options.is_empty() {
        return Err("没有可用的补全".into());
    }
    let intent = flatten_line(value.get("intent").and_then(|v| v.as_str()).unwrap_or(""));
    Ok(CompleteResult { intent, options })
}

fn format_complete_option(item: &Value) -> String {
    let text = if let Some(text) = item.as_str() {
        text
    } else {
        item.get("text").and_then(|v| v.as_str()).unwrap_or("")
    };
    flatten_line(text).trim_end_matches(['?', '？']).trim().to_string()
}

fn flatten_line(text: &str) -> String {
    text.replace(['\n', '\r'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn strip_fence(text: &str) -> String {
    let trimmed = text.trim();
    let Some(rest) = trimmed.strip_prefix("```") else {
        return trimmed.to_string();
    };
    let rest = rest.trim_start_matches(|ch: char| ch.is_ascii_alphanumeric()).trim_start();
    rest.strip_suffix("```").unwrap_or(rest).trim().to_string()
}

