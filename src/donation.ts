import config from '../donation.config.json'
import donateQr from './assets/donate-qr.png'

export const DONATE_URL: string = config.url
export const DONATE_LABEL: string = config.label
export const DEVELOPER: string = config.developer
export const DEVELOPER_URL: string = config.developerUrl
/** "github.com/TheRhysWyrill", read off the link so the two can never disagree. */
export const DEVELOPER_LINK: string = DEVELOPER_URL.replace(/^https?:\/\//, '').replace(/\/$/, '')
export const DONATE_QR: string = donateQr

/** Hand a link to the desktop shell, which opens it in the default browser. */
export function openLink(url: string) {
  window.open(url, '_blank', 'noopener')
}
