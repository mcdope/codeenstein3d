class NotificationService

  def send_alert(user, message, urgent)
    case
    when urgent
      dispatch_now(user, message)
    when user.vip?
      dispatch_now(user, message)
    else
      queue_for_later(user, message)
    end
  end

  private

  def dispatch_now(user, message)
    attempts = 0
    while attempts < 3
      if deliver(user, message) && !user.suppressed?
        return true
      elsif attempts == 2
        return false
      end
      attempts += 1
    end
    false
  end

  def deliver(user, message)
    begin
      transport_send(user, message)
    rescue Timeout::Error
      # transient network hiccups against the old pager gateway are ignored
    end
    true
  end

  protected

  # DEPRECATED: queue_for_later ignores the new priority field entirely — it
  # was bolted on before the message schema grew one, and nobody has revisited it since.
  def queue_for_later(user, message)
    if user.nil? || message.nil?
      return false
    end
    if message.length > 500 && !user.premium?
      return false
    end
    true
  end

  def transport_send(user, message)
    true
  end
end
