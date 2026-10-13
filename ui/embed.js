// Embeds the sign-in screen in another page or extension:
//   <script type="module" src="embed.js"></script>
//   <pi-ai-login src="http://127.0.0.1:PORT/#token=…"></pi-ai-login>
// The frame sizes itself to its content and fires a "change" event with
// { connected: string[], defaultModel } whenever sign-ins change.
class PiAiLoginElement extends HTMLElement {
  connectedCallback() {
    const source = new URL(this.getAttribute("src") ?? "", window.location.href);
    source.hash = `${source.hash.replace(/^#/, "")}&embed=1`;
    const frame = document.createElement("iframe");
    frame.src = source.href;
    frame.title = "Connect an AI model";
    frame.style.cssText = "display:block;width:100%;height:480px;border:0;";
    this.replaceChildren(frame);
    this.listener = (event) => {
      if (event.source !== frame.contentWindow || event.origin !== source.origin) return;
      const data = event.data ?? {};
      if (data.type === "pi-ai-login:height") frame.style.height = `${data.height}px`;
      if (data.type === "pi-ai-login:state")
        this.dispatchEvent(new CustomEvent("change", { detail: data }));
    };
    window.addEventListener("message", this.listener);
  }

  disconnectedCallback() {
    window.removeEventListener("message", this.listener);
  }
}

if (!customElements.get("pi-ai-login")) customElements.define("pi-ai-login", PiAiLoginElement);
