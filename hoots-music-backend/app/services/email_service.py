import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr

from app.config import settings


def is_configured() -> bool:
    return bool(settings.SMTP_HOST and settings.SMTP_USER and settings.SMTP_PASSWORD)


def send_email(to: str, subject: str, html_body: str, text_body: str = "") -> bool:
    """Returns True if actually sent, False if SMTP isn't configured (dev mode).

    Sends as multipart (plain text + HTML) with a proper display name in
    the From header — both meaningfully improve spam-folder odds compared
    to a bare HTML-only email from a raw address. Note: sending through a
    personal Gmail account will still land in spam sometimes no matter what,
    since Gmail doesn't extend real sender trust to third-party apps using
    it as a relay. A dedicated transactional service (Resend, Brevo,
    SendGrid — all have free tiers) fixes this properly via domain
    verification (SPF/DKIM/DMARC) — worth moving to before a real launch.
    """
    if not is_configured():
        return False

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = formataddr(("Hoots", settings.SMTP_FROM or settings.SMTP_USER))
    msg["To"] = to

    if text_body:
        msg.attach(MIMEText(text_body, "plain"))
    msg.attach(MIMEText(html_body, "html"))

    with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT) as server:
        server.starttls()
        server.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
        server.sendmail(settings.SMTP_USER, [to], msg.as_string())
    return True


def _template(title: str, body_html: str, button_text: str = "", button_url: str = "") -> str:
    button_html = ""
    if button_text and button_url:
        button_html = f"""
        <tr><td align="center" style="padding:28px 0 8px;">
          <a href="{button_url}"
             style="background:#8b5cf6;color:#ffffff;text-decoration:none;
                    padding:13px 30px;border-radius:999px;font-weight:600;
                    font-family:Arial,sans-serif;font-size:14px;display:inline-block;">
            {button_text}
          </a>
        </td></tr>
        <tr><td align="center" style="padding-top:6px;">
          <p style="font-family:Arial,sans-serif;font-size:11px;color:#565d73;word-break:break-all;">
            Or paste this link: <a href="{button_url}" style="color:#8b5cf6;">{button_url}</a>
          </p>
        </td></tr>
                """

    return f"""
<html>
  <body style="margin:0;padding:0;background:#0b0e17;">
    <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;background:#0b0e17;">
      <tr><td align="center">
        <table width="480" cellpadding="0" cellspacing="0"
               style="max-width:100%;background:#141824;border-radius:16px;
                      padding:36px 32px;font-family:Arial,sans-serif;">
          <tr><td align="center" style="padding-bottom:20px;">
            <span style="font-size:20px;font-weight:800;letter-spacing:3px;color:#a78bfa;">
              HOOTS
            </span>
          </td></tr>
          <tr><td>
            <h2 style="color:#e8e9f3;font-family:Arial,sans-serif;font-size:19px;margin:0 0 12px;">
              {title}
            </h2>
            <div style="color:#aeb2c4;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;">
              {body_html}
            </div>
          </td></tr>
          {button_html}
          <tr><td style="padding-top:24px;margin-top:20px;border-top:1px solid #262b3d;">
            <p style="font-family:Arial,sans-serif;font-size:11px;color:#565d73;margin:16px 0 0;">
              If you didn't request this, you can safely ignore this email.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>
"""


def verification_email(url: str) -> tuple[str, str]:
    html = _template(
        "Confirm your email",
        "Click below to verify your Hoots account and start listening.",
        "Verify email", url,
    )
    text = f"Confirm your Hoots account: {url}"
    return html, text


def welcome_email(name: str) -> tuple[str, str]:
    html = _template(
        f"Welcome, {name}! 🦉",
        "Your email is verified and your account is ready. Search for a song, "
        "build a playlist, and Hoots will start learning what you like.",
    )
    text = f"Welcome, {name}! Your Hoots account is verified and ready."
    return html, text


def login_notification_email(name: str, when_str: str) -> tuple[str, str]:
    html = _template(
        "New login to your account",
        f"Hey {name}, your Hoots account was just signed in to "
        f"<strong style='color:#e8e9f3;'>{when_str}</strong>. "
        "If this was you, no action needed — if not, change your password right away.",
    )
    text = f"Your Hoots account was signed in to at {when_str}. Wasn't you? Change your password."
    return html, text


def reset_password_email(url: str) -> tuple[str, str]:
    html = _template(
        "Reset your password",
        "We got a request to reset your Hoots password. This link expires in 30 minutes.",
        "Reset password", url,
    )
    text = f"Reset your Hoots password (expires in 30 min): {url}"
    return html, text
