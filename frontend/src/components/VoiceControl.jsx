import useAgent from '../hooks/useAgent'
import robotImage from '../assets/robot.png'

export default function VoiceControl() {
  const { callState, startVoiceCall, stopVoiceCall } = useAgent()
  const active = callState === 'connecting' || callState === 'connected'
  const connecting = callState === 'connecting'

  return (
    <button
      type="button"
      className={`voice-bot ${active ? 'active' : ''} ${connecting ? 'connecting' : ''}`}
      onClick={active ? stopVoiceCall : startVoiceCall}
      aria-label={active ? 'End voice conversation' : 'Talk to Agent'}
      title={connecting ? 'Connecting…' : active ? 'End voice conversation' : 'Talk to Agent'}
    >
      <span className="voice-bot-halo" />
      <img src={robotImage} alt="AI Browser Agent" />
      <span className="voice-bot-status" aria-hidden="true">
        {connecting ? '•••' : active ? '●' : ''}
      </span>
      <span className="voice-bot-label">{connecting ? 'Connecting…' : active ? 'Listening' : 'Talk to Agent'}</span>
    </button>
  )
}
