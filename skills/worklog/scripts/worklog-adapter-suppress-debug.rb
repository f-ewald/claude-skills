# frozen_string_literal: true

require 'logger'

# Suppresses DEBUG records before Ruby Logger formats multiline messages onto wl stdout.
module WorklogAdapterSuppressDebug
  # Discards a DEBUG message before Logger formats or writes it.
  def debug(*)
    true
  end
end

Logger.prepend(WorklogAdapterSuppressDebug)
