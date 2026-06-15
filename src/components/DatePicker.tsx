import React, { useState } from 'react';

interface DatePickerProps {
  date: Date;
  onChange: (date: Date) => void;
}

const DatePicker: React.FC<DatePickerProps> = ({ date, onChange }) => {
  const [selectedDate, setSelectedDate] = useState(date);

  const handleDateChange = (date: Date) => {
    setSelectedDate(date);
    onChange(date);
  };

  return (
    <input
      type='date'
      value={selectedDate.toISOString().split('T')[0]}
      onChange={(e) => handleDateChange(new Date(e.target.value))}
    />
  );
};

export default DatePicker;