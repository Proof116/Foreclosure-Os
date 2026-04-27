const followUps = [
  "Just checking in — are you still open to selling your property?",
  "Wanted to follow up — we can help before foreclosure progresses.",
  "Are you still considering selling your property?",
  "Time is getting tight with foreclosure — want to explore options?",
  "Final check — are you still open to selling?"
]
const runFollowUps = async () => {
  const leads = await supabase
    .from('leads')
    .select('*')

  for (const lead of leads.data) {
    if (lead.replied) continue

    const step = lead.follow_up_step || 0
    if (step >= followUps.length) continue

    const last = new Date(lead.last_contacted || lead.created_at)
    const now = new Date()

    const daysPassed = (now - last) / (1000 * 60 * 60 * 24)

    if (daysPassed >= 2) {
      await client.messages.create({
        body: followUps[step],
        from: 'YOUR_TWILIO_NUMBER',
        to: lead.phone
      })

      await supabase
        .from('leads')
        .update({
          follow_up_step: step + 1,
          last_contacted: new Date()
        })
        .eq('id', lead.id)
    }
  }
}
const cron = require('node-cron')

// Runs every day at 10AM
cron.schedule('0 10 * * *', () => {
  console.log('Running follow-ups...')
  runFollowUps()
})