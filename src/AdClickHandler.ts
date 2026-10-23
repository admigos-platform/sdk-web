export class AdClickHandler {
  openUrl(url: string): void {
    const ua = navigator.userAgent;

    if (/iPhone|iPad|iPod/i.test(ua)) {
      window.open(`itms-apps://${url}`, "_blank");
    } else if (/Android/i.test(ua)) {
      window.open(`market://details?id=${url}`, "_blank");
    } else {
      window.open(url, "_blank");
    }
  }
}
